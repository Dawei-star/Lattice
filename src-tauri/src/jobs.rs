//! 持久化任务队列（升级计划 P1-03）。
//!
//! 索引/链接/快照等后台任务全部落盘到 SQLite `jobs` 表：
//! 可重试（fail 自动回队，超过 max_attempts 记 failed）、
//! 可取消（running 通过 cancel_requested 协作取消）、
//! 可恢复（启动时把 interrupted 的 running 任务重排回 queued）。
//! 语义与 Express `server/src/lib/jobs.js` 对齐（契约清单 job_list/job_get/job_cancel）。

use crate::db;
use crate::time::{iso8601_utc, now_millis};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;
use uuid::Uuid;

pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_WAITING_CONFIRMATION: &str = "waiting_confirmation";
#[allow(dead_code)] // P1-04 命令面（契约测试）接线前仅测试使用
pub const STATUS_COMPLETED: &str = "completed";
#[allow(dead_code)] // P1-04 命令面（契约测试）接线前仅测试使用
pub const STATUS_FAILED: &str = "failed";
#[allow(dead_code)] // P1-04 命令面（契约测试）接线前仅测试使用
pub const STATUS_CANCELLED: &str = "cancelled";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub key: Option<String>,
    pub status: String,
    pub payload: Value,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub attempts: i64,
    pub max_attempts: i64,
    pub cancel_requested: bool,
    pub checkpoint: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunEventRecord {
    pub run_id: String,
    pub sequence: i64,
    pub event_type: String,
    pub payload: Value,
    pub created_at: String,
}

pub struct JobsQueue {
    connection: Mutex<Connection>,
}

impl JobsQueue {
    /// 与 Index 共用同一 SQLite 文件（WAL 模式支持多连接）。
    pub fn open(database: &Path) -> Result<Self, String> {
        let connection = db::open(database)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// 入队。同 `type + key` 的活跃任务（queued/running）直接返回现有任务（活跃幂等）；
    /// 终态任务同 key 再入队时重置重跑（status=queued、清空 result/error、attempts 归零）。
    pub fn enqueue(&self, kind: &str, key: Option<&str>, payload: &Value) -> Result<Job, String> {
        let connection = self.lock()?;
        if let Some(key) = key {
            let existing: Option<String> = connection
                .query_row(
                    "SELECT id FROM jobs WHERE type = ?1 AND key = ?2
                     AND status IN ('queued', 'running', 'cancelling') LIMIT 1",
                    params![kind, key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("查询幂等任务失败：{error}"))?;
            if let Some(id) = existing {
                return self
                    .get_locked(&connection, &id)?
                    .ok_or_else(|| "幂等任务刚刚消失，请重试".to_string());
            }
            // 终态同 key：重置重跑
            let terminal: Option<String> = connection
                .query_row(
                    "SELECT id FROM jobs WHERE type = ?1 AND key = ?2 LIMIT 1",
                    params![kind, key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("查询历史任务失败：{error}"))?;
            if let Some(id) = terminal {
                connection
                    .execute(
                        "UPDATE jobs SET status = 'queued', payload = ?2, result = NULL,
                         error = NULL, attempts = 0, cancel_requested = 0, checkpoint = NULL,
                         updated_at = ?3
                         WHERE id = ?1",
                        params![id, payload.to_string(), iso8601_utc(now_millis())],
                    )
                    .map_err(|error| format!("重置任务失败：{error}"))?;
                return self
                    .get_locked(&connection, &id)?
                    .ok_or_else(|| "重置后的任务不存在".to_string());
            }
        }
        let job = Job {
            id: Uuid::new_v4().to_string(),
            kind: kind.to_owned(),
            key: key.map(str::to_owned),
            status: STATUS_QUEUED.to_owned(),
            payload: payload.clone(),
            result: None,
            error: None,
            attempts: 0,
            max_attempts: 3,
            cancel_requested: false,
            checkpoint: None,
            created_at: iso8601_utc(now_millis()),
            updated_at: iso8601_utc(now_millis()),
        };
        connection
            .execute(
                "INSERT INTO jobs (id, type, key, status, payload, attempts, max_attempts,
                 cancel_requested, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'queued', ?4, 0, ?5, 0, ?6, ?6)",
                params![
                    job.id,
                    job.kind,
                    job.key,
                    job.payload.to_string(),
                    job.max_attempts,
                    job.created_at
                ],
            )
            .map_err(|error| format!("无法写入任务：{error}"))?;
        Ok(job)
    }

    /// 按状态/类型列出任务（created_at 正序，契约 job_list）。
    pub fn list(
        &self,
        status: Option<&str>,
        kind: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Job>, String> {
        let connection = self.lock()?;
        let mut sql = String::from(
            "SELECT id, type, key, status, payload, result, error, attempts, max_attempts,
             cancel_requested, checkpoint, created_at, updated_at FROM jobs WHERE 1=1",
        );
        let mut args: Vec<String> = Vec::new();
        if let Some(status) = status {
            args.push(status.to_owned());
            sql.push_str(&format!(" AND status = ?{}", args.len()));
        }
        if let Some(kind) = kind {
            args.push(kind.to_owned());
            sql.push_str(&format!(" AND type = ?{}", args.len()));
        }
        sql.push_str(&format!(
            " ORDER BY created_at LIMIT {}",
            limit.clamp(1, 500)
        ));
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(args.iter()), row_to_job)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn get(&self, id: &str) -> Result<Option<Job>, String> {
        let connection = self.lock()?;
        self.get_locked(&connection, id)
    }

    pub fn get_by_kind_key(&self, kind: &str, key: &str) -> Result<Option<Job>, String> {
        let connection = self.lock()?;
        let id: Option<String> = connection
            .query_row(
                "SELECT id FROM jobs WHERE type = ?1 AND key = ?2 LIMIT 1",
                params![kind, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        id.map(|id| self.get_locked(&connection, &id))
            .transpose()
            .map(|value| value.flatten())
    }

    /// 取消：queued 直接 cancelled；running/cancelling 置取消标记，
    /// 由执行器在检查点结束为 cancelled（与 Express "finish as cancelled" 一致）。
    pub fn cancel(&self, id: &str) -> Result<Option<Job>, String> {
        let connection = self.lock()?;
        let status: Option<String> = connection
            .query_row(
                "SELECT status FROM jobs WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(status) = status else {
            return Ok(None);
        };
        if status == STATUS_QUEUED {
            connection
                .execute(
                    "UPDATE jobs SET status = 'cancelled', updated_at = ?2 WHERE id = ?1",
                    params![id, iso8601_utc(now_millis())],
                )
                .map_err(|error| error.to_string())?;
        } else if status == STATUS_RUNNING {
            connection
                .execute(
                    "UPDATE jobs SET cancel_requested = 1, updated_at = ?2 WHERE id = ?1",
                    params![id, iso8601_utc(now_millis())],
                )
                .map_err(|error| error.to_string())?;
        }
        self.get_locked(&connection, id)
    }

    /// 执行器领取最旧的 queued 任务并置 running（attempts+1）。
    pub fn claim_next(&self, kind: &str) -> Result<Option<Job>, String> {
        let connection = self.lock()?;
        let id: Option<String> = connection
            .query_row(
                "SELECT id FROM jobs WHERE status = 'queued' AND type = ?1
                 ORDER BY created_at LIMIT 1",
                params![kind],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(id) = id else { return Ok(None) };
        connection
            .execute(
                "UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?2
                 WHERE id = ?1",
                params![id, iso8601_utc(now_millis())],
            )
            .map_err(|error| error.to_string())?;
        self.get_locked(&connection, &id)
    }

    /// 执行器在检查点调用：已请求取消的任务结束为 cancelled。
    /// 返回 true 表示任务已被取消，执行器应立即停止。
    pub fn checkpoint_cancelled(&self, id: &str) -> Result<bool, String> {
        let connection = self.lock()?;
        let cancelled: Option<bool> = connection
            .query_row(
                "SELECT cancel_requested FROM jobs WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if cancelled == Some(true) {
            connection
                .execute(
                    "UPDATE jobs SET status = 'cancelled', updated_at = ?2 WHERE id = ?1",
                    params![id, iso8601_utc(now_millis())],
                )
                .map_err(|error| error.to_string())?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn complete(&self, id: &str, result: &Value) -> Result<(), String> {
        let connection = self.lock()?;
        connection
            .execute(
                "UPDATE jobs SET status = 'completed', result = ?2, error = NULL, updated_at = ?3
                 WHERE id = ?1",
                params![id, result.to_string(), iso8601_utc(now_millis())],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// AI worker finished model generation but returned tool calls that still
    /// require frontend Gateway execution or user confirmation.
    pub fn wait_for_confirmation(&self, id: &str, result: &Value) -> Result<(), String> {
        let connection = self.lock()?;
        connection
            .execute(
                "UPDATE jobs SET status = 'waiting_confirmation', result = ?2, error = NULL, updated_at = ?3
                 WHERE id = ?1",
                params![id, result.to_string(), iso8601_utc(now_millis())],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 保存可恢复的阶段元数据。不得写入 API Key、完整请求或流式正文。
    pub fn set_checkpoint(&self, id: &str, checkpoint: &Value) -> Result<Option<Job>, String> {
        let connection = self.lock()?;
        connection
            .execute(
                "UPDATE jobs SET checkpoint = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, checkpoint.to_string(), iso8601_utc(now_millis())],
            )
            .map_err(|error| format!("保存任务检查点失败：{error}"))?;
        self.get_locked(&connection, id)
    }

    /// 将可恢复的失败/取消 Run 重新排队。已完成任务不可隐式重跑。
    pub fn resume(&self, id: &str) -> Result<Option<Job>, String> {
        let connection = self.lock()?;
        let status: Option<String> = connection
            .query_row(
                "SELECT status FROM jobs WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(status) = status else {
            return Ok(None);
        };
        if matches!(status.as_str(), STATUS_FAILED | STATUS_CANCELLED) {
            connection
                .execute(
                    "UPDATE jobs SET status = 'queued', result = NULL, error = NULL,
                     attempts = 0, cancel_requested = 0, updated_at = ?2 WHERE id = ?1",
                    params![id, iso8601_utc(now_millis())],
                )
                .map_err(|error| error.to_string())?;
        } else if !matches!(status.as_str(), STATUS_QUEUED | STATUS_RUNNING) {
            return Err("只有失败、取消或进行中的任务可以恢复".to_owned());
        }
        self.get_locked(&connection, id)
    }

    /// 追加 AI Run 事件。sequence 是客户端可用的断点，重复写入保持幂等。
    pub fn append_ai_event(
        &self,
        run_id: &str,
        sequence: i64,
        payload: &Value,
    ) -> Result<(), String> {
        let connection = self.lock()?;
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        connection
            .execute(
                "INSERT INTO ai_run_events (run_id, sequence, type, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(run_id, sequence) DO NOTHING",
                params![
                    run_id,
                    sequence,
                    event_type,
                    payload.to_string(),
                    iso8601_utc(now_millis())
                ],
            )
            .map_err(|error| format!("AI Run 事件落盘失败：{error}"))?;
        Ok(())
    }

    pub fn ai_events(
        &self,
        run_id: &str,
        after_sequence: i64,
        limit: usize,
    ) -> Result<Vec<AiRunEventRecord>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT run_id, sequence, type, payload, created_at
                 FROM ai_run_events
                 WHERE run_id = ?1 AND sequence > ?2
                 ORDER BY sequence LIMIT ?3",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![run_id, after_sequence, limit.clamp(1, 1000) as i64],
                |row| {
                    let payload: String = row.get(3)?;
                    Ok(AiRunEventRecord {
                        run_id: row.get(0)?,
                        sequence: row.get(1)?,
                        event_type: row.get(2)?,
                        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
                        created_at: row.get(4)?,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn ai_event_count(&self, run_id: &str) -> Result<i64, String> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM ai_run_events WHERE run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub fn fail_permanently(&self, id: &str, error: &str) -> Result<Job, String> {
        let connection = self.lock()?;
        connection
            .execute(
                "UPDATE jobs SET status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, error, iso8601_utc(now_millis())],
            )
            .map_err(|error| error.to_string())?;
        self.get_locked(&connection, id)?
            .ok_or_else(|| "任务不存在".to_string())
    }

    pub fn finish_cancelled(&self, id: &str) -> Result<(), String> {
        let connection = self.lock()?;
        connection
            .execute(
                "UPDATE jobs SET status = 'cancelled', updated_at = ?2 WHERE id = ?1",
                params![id, iso8601_utc(now_millis())],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 失败处理：未达重试上限回 queued（下次 claim 重试），达到上限记 failed。
    pub fn fail(&self, id: &str, error: &str) -> Result<Job, String> {
        let connection = self.lock()?;
        connection
            .execute(
                "UPDATE jobs SET error = ?2, updated_at = ?3,
                 status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END
                 WHERE id = ?1",
                params![id, error, iso8601_utc(now_millis())],
            )
            .map_err(|error| error.to_string())?;
        self.get_locked(&connection, id)?
            .ok_or_else(|| "任务不存在".to_string())
    }

    /// 启动恢复：上次异常退出遗留的 running 任务重排回 queued（可重试）。
    pub fn recover_interrupted(&self) -> Result<usize, String> {
        let connection = self.lock()?;
        let recovered = connection
            .execute(
                "UPDATE jobs SET status = 'queued', updated_at = ?1
                 WHERE status = 'running' OR status = 'cancelling'",
                params![iso8601_utc(now_millis())],
            )
            .map_err(|error| error.to_string())?;
        Ok(recovered)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.connection.lock().map_err(|error| error.to_string())
    }

    fn get_locked(&self, connection: &Connection, id: &str) -> Result<Option<Job>, String> {
        connection
            .query_row(
                "SELECT id, type, key, status, payload, result, error, attempts, max_attempts,
                 cancel_requested, checkpoint, created_at, updated_at FROM jobs WHERE id = ?1",
                params![id],
                row_to_job,
            )
            .optional()
            .map_err(|error| error.to_string())
    }
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    let payload: Option<String> = row.get(4)?;
    let result: Option<String> = row.get(5)?;
    let checkpoint: Option<String> = row.get(10)?;
    Ok(Job {
        id: row.get(0)?,
        kind: row.get(1)?,
        key: row.get(2)?,
        status: row.get(3)?,
        payload: payload
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null),
        result: result.and_then(|text| serde_json::from_str(&text).ok()),
        error: row.get(6)?,
        attempts: row.get(7)?,
        max_attempts: row.get(8)?,
        cancel_requested: row.get::<_, i64>(9)? != 0,
        checkpoint: checkpoint.and_then(|text| serde_json::from_str(&text).ok()),
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        JobsQueue, STATUS_CANCELLED, STATUS_COMPLETED, STATUS_FAILED, STATUS_QUEUED,
        STATUS_RUNNING, STATUS_WAITING_CONFIRMATION,
    };
    use serde_json::json;

    fn open_queue() -> (JobsQueue, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join(".lattice/lattice.db");
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        let queue = JobsQueue::open(&database).unwrap();
        (queue, directory)
    }

    #[test]
    fn job_lifecycle_persists_progress_and_result() {
        let (queue, _guard) = open_queue();
        let job = queue
            .enqueue("scan", None, &json!({"trigger": "manual"}))
            .unwrap();
        assert_eq!(job.status, STATUS_QUEUED);

        let claimed = queue.claim_next("scan").unwrap().unwrap();
        assert_eq!(claimed.id, job.id);
        assert_eq!(claimed.status, STATUS_RUNNING);
        assert_eq!(claimed.attempts, 1);
        assert_eq!(claimed.payload["trigger"], "manual");

        queue.complete(&job.id, &json!({"added": 3})).unwrap();
        let done = queue.get(&job.id).unwrap().unwrap();
        assert_eq!(done.status, STATUS_COMPLETED);
        assert_eq!(done.result.unwrap()["added"], 3);
    }

    #[test]
    fn failures_record_error_then_retry_until_budget_exhausted() {
        let (queue, _guard) = open_queue();
        let job = queue.enqueue("scan", None, &json!(null)).unwrap();
        queue.claim_next("scan").unwrap();
        // 第 1 次失败（attempts=1 < 3）→ 回 queued
        let retried = queue.fail(&job.id, "boom-1").unwrap();
        assert_eq!(retried.status, STATUS_QUEUED);
        assert_eq!(retried.error.as_deref(), Some("boom-1"));
        // 连续失败到上限 → failed
        for round in 2..=3 {
            queue.claim_next("scan").unwrap();
            let failed = queue.fail(&job.id, &format!("boom-{round}")).unwrap();
            let expected = if round < 3 {
                STATUS_QUEUED
            } else {
                STATUS_FAILED
            };
            assert_eq!(
                failed.status, expected,
                "第 {round} 次失败后应为 {expected}"
            );
        }
    }

    #[test]
    fn active_jobs_with_same_key_are_idempotent() {
        let (queue, _guard) = open_queue();
        let first = queue
            .enqueue("scan", Some("vault-scan"), &json!(null))
            .unwrap();
        let second = queue
            .enqueue("scan", Some("vault-scan"), &json!(null))
            .unwrap();
        assert_eq!(first.id, second.id, "活跃任务同 key 幂等");
    }

    #[test]
    fn terminal_job_with_same_key_resets_and_reruns() {
        let (queue, _guard) = open_queue();
        let first = queue
            .enqueue("scan", Some("vault-scan"), &json!(null))
            .unwrap();
        queue.claim_next("scan").unwrap();
        queue.complete(&first.id, &json!({"added": 9})).unwrap();

        let rerun = queue
            .enqueue("scan", Some("vault-scan"), &json!({"v": 2}))
            .unwrap();
        assert_eq!(rerun.id, first.id, "复用同一行");
        assert_eq!(rerun.status, STATUS_QUEUED);
        assert_eq!(rerun.attempts, 0, "attempts 重置");
        assert!(rerun.result.is_none(), "旧结果清空");
        assert_eq!(rerun.payload["v"], 2);
    }

    #[test]
    fn queued_job_cancels_directly_and_running_finishes_as_cancelled() {
        let (queue, _guard) = open_queue();
        let queued = queue.enqueue("scan", None, &json!(null)).unwrap();
        let cancelled = queue.cancel(&queued.id).unwrap().unwrap();
        assert_eq!(cancelled.status, STATUS_CANCELLED);

        let running = queue.enqueue("scan", None, &json!(null)).unwrap();
        queue.claim_next("scan").unwrap();
        let requested = queue.cancel(&running.id).unwrap().unwrap();
        assert_eq!(requested.status, STATUS_RUNNING, "running 取消先置标记");
        assert!(requested.cancel_requested);
        // 执行器检查点发现取消 → finish as cancelled
        assert!(queue.checkpoint_cancelled(&running.id).unwrap());
        assert_eq!(
            queue.get(&running.id).unwrap().unwrap().status,
            STATUS_CANCELLED
        );
    }

    #[test]
    fn startup_recovery_requeues_interrupted_jobs() {
        let (queue, _guard) = open_queue();
        let job = queue.enqueue("scan", None, &json!(null)).unwrap();
        queue.claim_next("scan").unwrap();
        // 模拟崩溃后状态：直接改回 running（claim 已置 running，此处无需操作）
        let recovered = queue.recover_interrupted().unwrap();
        assert_eq!(recovered, 1);
        let again = queue.get(&job.id).unwrap().unwrap();
        assert_eq!(again.status, STATUS_QUEUED);
        // 恢复后可再次领取执行
        assert!(queue.claim_next("scan").unwrap().is_some());
    }

    #[test]
    fn list_filters_by_status_and_kind() {
        let (queue, _guard) = open_queue();
        queue.enqueue("scan", None, &json!(null)).unwrap();
        let other = queue.enqueue("links", None, &json!(null)).unwrap();
        queue.claim_next("links").unwrap();
        queue.complete(&other.id, &json!(null)).unwrap();

        let queued = queue.list(Some(STATUS_QUEUED), None, 50).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].kind, "scan");
        let completed = queue
            .list(Some(STATUS_COMPLETED), Some("links"), 50)
            .unwrap();
        assert_eq!(completed.len(), 1);
        let all = queue.list(None, None, 50).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn ai_events_are_append_only_and_resume_is_idempotent() {
        let (queue, _guard) = open_queue();
        let run = queue
            .enqueue("ai-run", Some("run-1"), &json!({"message": "hello"}))
            .unwrap();
        queue
            .append_ai_event("run-1", 1, &json!({"type": "status", "status": "queued"}))
            .unwrap();
        queue
            .append_ai_event("run-1", 1, &json!({"type": "status", "status": "wrong"}))
            .unwrap();
        let events = queue.ai_events("run-1", 0, 10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["status"], "queued");
        assert_eq!(
            queue
                .get_by_kind_key("ai-run", "run-1")
                .unwrap()
                .unwrap()
                .id,
            run.id
        );
        queue.claim_next("ai-run").unwrap();
        queue.fail(&run.id, "temporary").unwrap();
        assert_eq!(
            queue.resume(&run.id).unwrap().unwrap().status,
            STATUS_QUEUED
        );
        assert_eq!(
            queue.resume(&run.id).unwrap().unwrap().status,
            STATUS_QUEUED
        );
    }

    #[test]
    fn checkpoints_survive_cancel_and_resume_without_storing_request_data() {
        let (queue, _guard) = open_queue();
        let run = queue
            .enqueue(
                "ai-run",
                Some("run-checkpoint"),
                &json!({"message": "hello"}),
            )
            .unwrap();
        queue
            .set_checkpoint(&run.id, &json!({"stage": "generating", "sequence": 4}))
            .unwrap();
        queue.claim_next("ai-run").unwrap();
        queue.cancel(&run.id).unwrap();
        queue.checkpoint_cancelled(&run.id).unwrap();

        let cancelled = queue.get(&run.id).unwrap().unwrap();
        assert_eq!(cancelled.checkpoint.unwrap()["stage"], "generating");

        let resumed = queue.resume(&run.id).unwrap().unwrap();
        assert_eq!(resumed.status, STATUS_QUEUED);
        assert_eq!(resumed.checkpoint.unwrap()["sequence"], 4);
    }

    #[test]
    fn ai_run_can_wait_for_tool_confirmation_without_becoming_completed() {
        let (queue, _guard) = open_queue();
        let job = queue
            .enqueue("ai-run", Some("run-wait"), &json!({"message":"task"}))
            .unwrap();
        queue.claim_next("ai-run").unwrap();
        queue
            .wait_for_confirmation(&job.id, &json!({"toolCalls":[{"id":"call-1"}]}))
            .unwrap();
        let waiting = queue.get(&job.id).unwrap().unwrap();
        assert_eq!(waiting.status, STATUS_WAITING_CONFIRMATION);
        assert_eq!(waiting.result.unwrap()["toolCalls"][0]["id"], "call-1");
    }
}
