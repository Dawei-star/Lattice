//! 日志追踪与指标（地基 §5.6，W8）：run 维度指标落 `ai_trace` 表（W1 迁移 v12 预建），
//! 按 task_type 聚合 P50/P95。凭据与正文永不入库——表结构只有
//! 计量字段（provider/model/ttft/tokens/cost），sanitize 天然满足。
//!
//! 成本估算消费 W3 模型目录的 1k 单价；本机推理（无价格条目）恒为零成本。

use crate::db;
use crate::time::{iso8601_utc, now_millis};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

/// 一条 run 的计量条目（run_id 主键，重试覆盖）。
#[derive(Debug, Clone)]
pub struct TraceEntry {
    pub run_id: String,
    pub task_type: String,
    pub provider: String,
    pub model: String,
    pub ttft_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSummaryItem {
    pub task_type: String,
    pub count: u64,
    pub p50_ttft_ms: Option<u64>,
    pub p95_ttft_ms: Option<u64>,
    pub p50_duration_ms: Option<u64>,
    pub total_tokens: u64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceQueryResult {
    pub entries: Vec<Value>,
    pub summary: Vec<TraceSummaryItem>,
}

/// 就近排名百分位（样本不足 2 条时返回唯一值/None）。
pub fn percentile(sorted: &[u64], ratio: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    if sorted.len() == 1 {
        return Some(sorted[0]);
    }
    let index = ((ratio * (sorted.len() - 1) as f64).round()) as usize;
    Some(sorted[index.min(sorted.len() - 1)])
}

/// 按目录 1k 单价估算成本（模型未在目录或缺价格 → None，本机模型天然 None）。
pub fn estimate_cost_usd(
    catalog: &crate::ai::core::provider::catalog::ModelCatalog,
    model: &str,
    prompt_tokens: u64,
    completion_tokens: u64,
) -> Option<f64> {
    let pricing = catalog
        .services
        .iter()
        .flat_map(|service| service.models.iter())
        .find(|entry| entry.id.eq_ignore_ascii_case(model))
        .map(|entry| {
            (
                entry.capabilities.prompt_cost_per_1k_usd,
                entry.capabilities.completion_cost_per_1k_usd,
            )
        })?;
    let (prompt_cost, completion_cost) = pricing;
    let prompt_cost = prompt_cost?;
    let completion_cost = completion_cost?;
    let cost =
        (prompt_tokens as f64 / 1000.0) * prompt_cost + (completion_tokens as f64 / 1000.0) * completion_cost;
    Some((cost * 1e6).round() / 1e6)
}

pub struct TraceStore {
    connection: Mutex<Connection>,
}

impl TraceStore {
    pub fn open(database: &Path) -> Result<Self, String> {
        Ok(Self {
            connection: Mutex::new(db::open(database)?),
        })
    }

    pub fn record(&self, entry: &TraceEntry) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO ai_trace (run_id, task_type, provider, model, ttft_ms, duration_ms,
                     prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(run_id) DO UPDATE SET
                   task_type = excluded.task_type,
                   provider = excluded.provider,
                   model = excluded.model,
                   ttft_ms = excluded.ttft_ms,
                   duration_ms = excluded.duration_ms,
                   prompt_tokens = excluded.prompt_tokens,
                   completion_tokens = excluded.completion_tokens,
                   total_tokens = excluded.total_tokens,
                   cost_usd = excluded.cost_usd,
                   created_at = excluded.created_at",
                rusqlite::params![
                    entry.run_id,
                    entry.task_type,
                    entry.provider,
                    entry.model,
                    entry.ttft_ms.map(|value| value as i64),
                    entry.duration_ms.map(|value| value as i64),
                    entry.prompt_tokens.map(|value| value as i64),
                    entry.completion_tokens.map(|value| value as i64),
                    entry.total_tokens.map(|value| value as i64),
                    entry.cost_usd,
                    iso8601_utc(now_millis()),
                ],
            )
            .map_err(|error| format!("AI 指标落库失败：{error}"))?;
        Ok(())
    }

    /// 查询：最近 N 条明细 + 按 task_type 的 P50/P95 汇总（聚合样本取该类型最近 500 条）。
    pub fn query(&self, task_type: Option<&str>, limit: u32) -> Result<TraceQueryResult, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|error| error.to_string())?;
        let limit = limit.clamp(1, 200) as usize;
        let filter = task_type.filter(|value| !value.is_empty());
        let entries: Vec<Value> = {
            let mut statement = connection
                .prepare(
                    "SELECT run_id, task_type, provider, model, ttft_ms, duration_ms,
                            prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at
                     FROM ai_trace
                     WHERE (?1 IS NULL OR task_type = ?1)
                     ORDER BY created_at DESC, run_id DESC
                     LIMIT ?2",
                )
                .map_err(|error| format!("AI 指标查询失败：{error}"))?;
            let rows = statement
                .query_map(rusqlite::params![filter, limit as i64], |row| {
                    let integer = |index: usize| -> Result<Option<u64>, rusqlite::Error> {
                        Ok(row.get::<_, Option<i64>>(index)?.map(|value| value.max(0) as u64))
                    };
                    Ok(serde_json::json!({
                        "runId": row.get::<_, String>(0)?,
                        "taskType": row.get::<_, String>(1)?,
                        "provider": row.get::<_, String>(2)?,
                        "model": row.get::<_, String>(3)?,
                        "ttftMs": integer(4)?,
                        "durationMs": integer(5)?,
                        "promptTokens": integer(6)?,
                        "completionTokens": integer(7)?,
                        "totalTokens": integer(8)?,
                        "costUsd": row.get::<_, Option<f64>>(9)?,
                        "createdAt": row.get::<_, String>(10)?,
                    }))
                })
                .map_err(|error| format!("AI 指标查询失败：{error}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("AI 指标查询失败：{error}"))?
        };

        // 汇总：按 task_type 聚合最近 500 条
        let mut summary = Vec::new();
        let mut task_statement = connection
            .prepare(
                "SELECT DISTINCT task_type FROM ai_trace WHERE (?1 IS NULL OR task_type = ?1)",
            )
            .map_err(|error| format!("AI 指标查询失败：{error}"))?;
        let task_types: Vec<String> = task_statement
            .query_map(rusqlite::params![filter], |row| row.get(0))
            .map_err(|error| format!("AI 指标查询失败：{error}"))?
            .collect::<Result<_, _>>()
            .map_err(|error| format!("AI 指标查询失败：{error}"))?;
        for task in task_types {
            let collect = |sql: &str| -> Result<Vec<u64>, String> {
                let mut statement = connection
                    .prepare(sql)
                    .map_err(|error| format!("AI 指标查询失败：{error}"))?;
                let values = statement
                    .query_map(rusqlite::params![task], |row| {
                        Ok(row.get::<_, Option<i64>>(0)?.map(|value| value.max(0) as u64))
                    })
                    .map_err(|error| format!("AI 指标查询失败：{error}"))?
                    .filter_map(|value| value.ok().flatten())
                    .take(500)
                    .collect::<Vec<_>>();
                Ok(values)
            };
            let mut ttft = collect(
                "SELECT ttft_ms FROM ai_trace WHERE task_type = ?1 AND ttft_ms IS NOT NULL ORDER BY created_at DESC",
            )?;
            let mut duration = collect(
                "SELECT duration_ms FROM ai_trace WHERE task_type = ?1 AND duration_ms IS NOT NULL ORDER BY created_at DESC",
            )?;
            let totals = connection
                .query_row(
                    "SELECT count(*), coalesce(sum(total_tokens), 0), coalesce(sum(cost_usd), 0)
                     FROM ai_trace WHERE task_type = ?1",
                    rusqlite::params![task],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?.max(0) as u64,
                            row.get::<_, i64>(1)?.max(0) as u64,
                            row.get::<_, f64>(2)?,
                        ))
                    },
                )
                .map_err(|error| format!("AI 指标查询失败：{error}"))?;
            ttft.sort_unstable();
            duration.sort_unstable();
            summary.push(TraceSummaryItem {
                task_type: task,
                count: totals.0,
                p50_ttft_ms: percentile(&ttft, 0.50),
                p95_ttft_ms: percentile(&ttft, 0.95),
                p50_duration_ms: percentile(&duration, 0.50),
                total_tokens: totals.1,
                total_cost_usd: (totals.2 * 1e6).round() / 1e6,
            });
        }
        Ok(TraceQueryResult { entries, summary })
    }
}

#[cfg(test)]
mod tests {
    use super::{TraceEntry, TraceStore, estimate_cost_usd, percentile};
    use crate::ai::core::provider::catalog::ModelCatalog;

    fn entry(run_id: &str, task: &str, ttft: u64, tokens: u64) -> TraceEntry {
        TraceEntry {
            run_id: run_id.to_owned(),
            task_type: task.to_owned(),
            provider: "tauri".to_owned(),
            model: "deepseek-chat".to_owned(),
            ttft_ms: Some(ttft),
            duration_ms: Some(ttft * 10),
            prompt_tokens: Some(tokens),
            completion_tokens: Some(tokens / 4),
            total_tokens: Some(tokens + tokens / 4),
            cost_usd: None,
        }
    }

    #[test]
    fn percentile_uses_nearest_rank() {
        assert_eq!(percentile(&[], 0.5), None);
        assert_eq!(percentile(&[7], 0.5), Some(7));
        let sorted = [10, 20, 30, 40, 50];
        assert_eq!(percentile(&sorted, 0.5), Some(30));
        assert_eq!(percentile(&sorted, 0.95), Some(50));
    }

    #[test]
    fn cost_estimation_uses_catalog_pricing() {
        let catalog = ModelCatalog::builtin();
        // 目录种子：DeepSeek-V4.1-Flash = 0.00028 / 0.0011
        let cost = estimate_cost_usd(&catalog, "DeepSeek-V4.1-Flash", 1000, 1000).unwrap();
        assert!((cost - 0.00138).abs() < 1e-9);
        // 未入目录的模型 → None（本机/未知模型零成本显示）
        assert_eq!(estimate_cost_usd(&catalog, "unknown-model", 100, 100), None);
    }

    #[test]
    fn record_and_query_with_summary() {
        let directory = tempfile::tempdir().unwrap();
        let store = TraceStore::open(&directory.path().join("lattice.db")).unwrap();
        for index in 0..5 {
            store
                .record(&entry(&format!("run-{index}"), "task", 100 + index * 10, 500))
                .unwrap();
        }
        store.record(&entry("run-quick", "quick", 50, 100)).unwrap();
        // 同 run_id 覆盖
        store.record(&entry("run-quick", "quick", 80, 120)).unwrap();

        let result = store.query(None, 10).unwrap();
        assert_eq!(result.entries.len(), 6);
        let quick = result.entries.iter().find(|item| item["runId"] == "run-quick").unwrap();
        assert_eq!(quick["ttftMs"], 80, "同 run_id 应覆盖旧记录");

        let task_summary = result.summary.iter().find(|item| item.task_type == "task").unwrap();
        assert_eq!(task_summary.count, 5);
        assert_eq!(task_summary.p50_ttft_ms, Some(120));
        assert_eq!(task_summary.p95_ttft_ms, Some(140));

        let filtered = store.query(Some("quick"), 10).unwrap();
        assert_eq!(filtered.entries.len(), 1);
        assert_eq!(filtered.summary.len(), 1);
    }
}
