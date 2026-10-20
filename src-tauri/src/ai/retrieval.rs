//! AI 检索结果融合。
//!
//! 该模块只处理已经完成权限过滤和结构化过滤的候选，不执行数据库查询。
//! 这样 RRF、去重和时间权重可以用纯函数回归测试，也不会让融合层拥有
//! 绕过检索权限边界的能力。

use crate::index::SearchItem;
use crate::time::now_millis;
use std::collections::HashMap;

const DEFAULT_RRF_K: f32 = 60.0;
const RECENCY_WEIGHT: f32 = 0.02;
const RECENCY_HALF_LIFE_DAYS: f32 = 30.0;
const MILLIS_PER_DAY: f32 = 86_400_000.0;

#[derive(Debug)]
pub struct FusedSearchItem {
    pub item: SearchItem,
    pub score: f32,
    pub sources: Vec<String>,
}

struct Aggregate {
    item: SearchItem,
    score: f32,
    sources: Vec<String>,
    best_rank: usize,
}

/// 使用当前时间做时间权重的混合召回。
pub fn fuse_search_results(
    sources: &[(&str, &[SearchItem])],
    limit: usize,
) -> Vec<FusedSearchItem> {
    fuse_search_results_at(sources, limit, now_millis())
}

/// 可注入时间的融合入口，保证时间权重有确定性测试。
pub fn fuse_search_results_at(
    sources: &[(&str, &[SearchItem])],
    limit: usize,
    now: i64,
) -> Vec<FusedSearchItem> {
    if limit == 0 {
        return Vec::new();
    }

    let mut aggregates: HashMap<String, Aggregate> = HashMap::new();
    for (source_name, items) in sources {
        for (index, item) in items.iter().enumerate() {
            let rank = index + 1;
            let key = dedupe_key(item);
            let rrf_score = 1.0 / (DEFAULT_RRF_K + rank as f32);
            if let Some(aggregate) = aggregates.get_mut(&key) {
                aggregate.score += rrf_score;
                if !aggregate.sources.iter().any(|source| source == source_name) {
                    aggregate.sources.push((*source_name).to_owned());
                }
                if is_better_duplicate(item, rank, &aggregate.item, aggregate.best_rank) {
                    aggregate.item = item.clone();
                    aggregate.best_rank = rank;
                }
                // A duplicate document is one logical result; its freshness must
                // not be multiplied by the number of recall channels.
            } else {
                aggregates.insert(
                    key,
                    Aggregate {
                        item: item.clone(),
                        score: rrf_score,
                        sources: vec![(*source_name).to_owned()],
                        best_rank: rank,
                    },
                );
            }
        }
    }

    // Add freshness exactly once for each logical document after channels merge.
    for aggregate in aggregates.values_mut() {
        aggregate.score +=
            RECENCY_WEIGHT * recency_factor(aggregate.item.updated_at.as_deref(), now);
    }

    let mut values = aggregates
        .into_values()
        .map(|aggregate| FusedSearchItem {
            item: aggregate.item,
            score: aggregate.score,
            sources: aggregate.sources,
        })
        .collect::<Vec<_>>();
    values.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.item.file_path.cmp(&right.item.file_path))
    });
    values.truncate(limit);
    values
}

/// 本地确定性重排基线：RRF 负责跨来源稳定融合，这里只用可解释的
/// 标题/摘要命中、查询词覆盖率和置顶状态做小幅调整。后续接入小模型
/// 时可以替换本函数而不改变权限过滤与召回协议。
pub fn rerank_search_results(
    mut results: Vec<FusedSearchItem>,
    query: &str,
    limit: usize,
) -> Vec<FusedSearchItem> {
    let query_lower = query.trim().to_lowercase();
    let terms = query_terms(&query_lower);
    for result in &mut results {
        let title = result.item.title.to_lowercase();
        let excerpt = result.item.excerpt.to_lowercase();
        if !query_lower.is_empty() && title.contains(&query_lower) {
            result.score += 0.04;
        }
        if !query_lower.is_empty() && excerpt.contains(&query_lower) {
            result.score += 0.02;
        }
        if !terms.is_empty() {
            let covered = terms
                .iter()
                .filter(|term| title.contains(term.as_str()) || excerpt.contains(term.as_str()))
                .count();
            result.score += 0.02 * covered as f32 / terms.len() as f32;
        }
        if result.item.is_pinned {
            result.score += 0.005;
        }
    }
    results.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.item.file_path.cmp(&right.item.file_path))
    });
    results.truncate(limit);
    results
}

fn query_terms(query: &str) -> Vec<String> {
    query
        .split(|character: char| {
            character.is_whitespace()
                || matches!(
                    character,
                    ',' | '.'
                        | '，'
                        | '。'
                        | '、'
                        | '；'
                        | ';'
                        | ':'
                        | '：'
                        | '?'
                        | '？'
                        | '!'
                        | '！'
                )
        })
        .filter(|term| !term.is_empty())
        .map(str::to_owned)
        .collect()
}

fn dedupe_key(item: &SearchItem) -> String {
    item.content_hash
        .as_ref()
        .map(|hash| format!("hash:{hash}"))
        .unwrap_or_else(|| format!("path:{}", item.file_path))
}

fn is_better_duplicate(
    candidate: &SearchItem,
    candidate_rank: usize,
    current: &SearchItem,
    current_rank: usize,
) -> bool {
    match (&candidate.updated_at, &current.updated_at) {
        (Some(candidate_time), Some(current_time)) if candidate_time != current_time => {
            candidate_time > current_time
        }
        (Some(_), None) => true,
        (None, Some(_)) => false,
        _ => candidate_rank < current_rank,
    }
}

fn recency_factor(updated_at: Option<&str>, now: i64) -> f32 {
    let Some(updated_at) = updated_at.and_then(parse_iso8601_millis) else {
        return 0.0;
    };
    let age_days = (now.saturating_sub(updated_at).max(0) as f32) / MILLIS_PER_DAY;
    (-std::f32::consts::LN_2 * age_days / RECENCY_HALF_LIFE_DAYS).exp()
}

fn parse_iso8601_millis(value: &str) -> Option<i64> {
    if value.len() < 20
        || (value.as_bytes().get(19) != Some(&b'Z') && value.as_bytes().get(19) != Some(&b'.'))
    {
        return None;
    }
    let year = parse_number(&value[0..4])?;
    let month = parse_number(&value[5..7])?;
    let day = parse_number(&value[8..10])?;
    let hour = parse_number(&value[11..13])?;
    let minute = parse_number(&value[14..16])?;
    let second = parse_number(&value[17..19])?;
    if value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
        || value.as_bytes().get(16) != Some(&b':')
    {
        return None;
    }
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let fraction = if value.as_bytes().get(19) == Some(&b'.') {
        let digits = value[20..].trim_end_matches('Z');
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let millis = digits.chars().take(3).collect::<String>();
        millis.parse::<i64>().ok()? * 10_i64.pow(3_u32.saturating_sub(millis.len() as u32))
    } else {
        0
    };
    if value.as_bytes().get(19) == Some(&b'Z') || value[20..].ends_with('Z') {
        Some(
            (days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
                * 1_000
                + fraction,
        )
    } else {
        None
    }
}

fn parse_number(value: &str) -> Option<i64> {
    value.parse::<i64>().ok()
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = (if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    }) / 400;
    let year_of_era = adjusted_year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::{fuse_search_results_at, parse_iso8601_millis, rerank_search_results};
    use crate::index::SearchItem;

    fn item(path: &str, hash: Option<&str>, updated_at: Option<&str>) -> SearchItem {
        SearchItem {
            id: path.to_owned(),
            title: path.to_owned(),
            folder_id: None,
            file_path: path.to_owned(),
            is_pinned: false,
            content_hash: hash.map(str::to_owned),
            properties_json: None,
            updated_at: updated_at.map(str::to_owned),
            excerpt: path.to_owned(),
        }
    }

    #[test]
    fn rrf_rewards_documents_returned_by_multiple_sources() {
        let fts = vec![
            item("shared.md", Some("hash"), Some("2026-10-01T00:00:00.000Z")),
            item("fts-only.md", None, Some("2026-10-01T00:00:00.000Z")),
        ];
        let like = vec![
            item("like-only.md", None, Some("2026-10-01T00:00:00.000Z")),
            item(
                "same-content.md",
                Some("hash"),
                Some("2026-10-01T00:00:00.000Z"),
            ),
        ];
        let result = fuse_search_results_at(
            &[("fts5", &fts), ("like", &like)],
            3,
            parse_iso8601_millis("2026-10-01T00:00:00.000Z").unwrap(),
        );
        assert_eq!(result[0].item.content_hash.as_deref(), Some("hash"));
        assert_eq!(result[0].sources, vec!["fts5", "like"]);
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn duplicate_content_hash_is_emitted_once_and_newer_copy_wins() {
        let old = vec![item(
            "old.md",
            Some("same"),
            Some("2026-09-01T00:00:00.000Z"),
        )];
        let new = vec![item(
            "new.md",
            Some("same"),
            Some("2026-10-01T00:00:00.000Z"),
        )];
        let result = fuse_search_results_at(
            &[("fts5", &old), ("like", &new)],
            10,
            parse_iso8601_millis("2026-10-02T00:00:00.000Z").unwrap(),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].item.file_path, "new.md");
    }

    #[test]
    fn recent_documents_receive_a_time_weight() {
        let results = vec![
            item("old.md", None, Some("2026-01-01T00:00:00.000Z")),
            item("recent.md", None, Some("2026-10-01T00:00:00.000Z")),
        ];
        let result = fuse_search_results_at(
            &[("fts5", &results)],
            2,
            parse_iso8601_millis("2026-10-02T00:00:00.000Z").unwrap(),
        );
        assert_eq!(result[0].item.file_path, "recent.md");
    }

    #[test]
    fn lexical_rerank_prefers_exact_title_and_excerpt_matches() {
        let results = vec![
            item("weak.md", None, Some("2026-10-01T00:00:00.000Z")),
            item("strong.md", None, Some("2026-10-01T00:00:00.000Z")),
        ];
        let mut results = fuse_search_results_at(
            &[("fts5", &results)],
            2,
            parse_iso8601_millis("2026-10-01T00:00:00.000Z").unwrap(),
        );
        results[1].item.title = "权限测试".to_owned();
        results[1].item.excerpt = "权限测试命中".to_owned();
        let ranked = rerank_search_results(results, "权限测试", 2);
        assert_eq!(ranked[0].item.title, "权限测试");
    }
}
