//! 上下文与记忆（地基 §5.4，W6；memory 物理归位 W7c 完成）。
//!
//! `ContextComposer` 与 web `buildAiContext + serializeAiContext` **字节级同构**：
//! 相同输入必须产出相同的块序（system → tool → memory → retrieval → history →
//! attachment → external）、相同的预算截断（4 个 UTF-16 单位 = 1 token，
//! `…[已按预算截断]` 标记、放不下的块整块丢弃）、相同的历史压缩（>12 条时
//! 首二 + 约束/待办保留块 + 中间摘要 + 尾四）。契约由
//! `tests/fixtures/context-serialization.json` 双侧同断言钉死。

// 接线过渡期，本模块部分出口仅由契约测试构造（dead_code 为预期状态）
#![allow(dead_code)]

pub(crate) mod memory;

use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

const HISTORY_COMPRESSION_THRESHOLD: usize = 12;
const MAX_PRESERVED_HISTORY_ITEMS: usize = 8;
const TRUNCATION_MARKER: &str = "…[已按预算截断]";

/// 序列化所需的最小块形状（web `AiContextBlock` 的对齐子集）。
#[derive(Debug, Clone, PartialEq)]
pub struct ContextBlock {
    pub id: String,
    pub source: String,
    pub content: String,
    pub trusted: bool,
    pub truncated: bool,
    pub compressed: bool,
}

/// 检索条目（`trusted = false`，进模型正文时包 untrusted 标签）。
#[derive(Debug, Clone)]
pub struct RetrievalItem {
    pub id: Option<String>,
    pub content: String,
    pub citation_id: Option<String>,
}

/// 外部上下文条目（MCP / 联网，`trusted = false`）。
#[derive(Debug, Clone)]
pub struct ExternalItem {
    pub id: Option<String>,
    pub content: String,
    pub provider: Option<String>,
    pub origin: Option<String>,
}

/// 组装输入。`tools` 携带调用方预序列化的 JSON 字符串，避免跨语言键序漂移。
#[derive(Debug, Default)]
pub struct ComposerInput {
    pub system: Vec<String>,
    pub tools: Vec<(String, String)>,
    pub memory: Vec<String>,
    pub retrieval: Vec<RetrievalItem>,
    pub history: Vec<String>,
    pub attachments: Vec<String>,
    pub external: Vec<ExternalItem>,
    pub max_tokens: Option<usize>,
}

#[derive(Debug, Default)]
pub struct ContextPackage {
    pub blocks: Vec<ContextBlock>,
    pub budget_tokens: Option<usize>,
    pub estimated_tokens: usize,
    pub truncated: bool,
    pub compressed_history: bool,
}

impl ContextPackage {
    /// 与 web `serializeAiContext` 逐字节一致：可信块用 source 作标签，
    /// 不可信块用 `untrusted_{source}`，块间以空行分隔。
    pub fn serialized(&self) -> String {
        self.blocks
            .iter()
            .map(|block| {
                let label = if block.trusted {
                    block.source.clone()
                } else {
                    format!("untrusted_{}", block.source)
                };
                format!("<{label} id=\"{}\">\n{}\n</{label}>", block.id, block.content)
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

// ── UTF-16 口径：与 JS 的 string.length / slice 对齐 ─────────────────────

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn utf16_truncate(value: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for character in value.chars() {
        let cost = character.len_utf16();
        if units + cost > limit {
            break;
        }
        out.push(character);
        units += cost;
    }
    out
}

fn estimate_tokens(content: &str) -> usize {
    if content.is_empty() {
        return 0;
    }
    content.encode_utf16().count().div_ceil(4)
}

fn make_block(id: String, source: &str, content: String, trusted: bool) -> ContextBlock {
    ContextBlock {
        id,
        source: source.to_owned(),
        content,
        trusted,
        truncated: false,
        compressed: false,
    }
}

fn constraint_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)必须|不要|不能|请保持|要求|约束|目标|务必|禁止|只允许|截止").unwrap()
    })
}

fn todo_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)^-\s*\[[ xX]\]|TODO|待办|下一步|后续|计划|任务").unwrap()
    })
}

fn compact_history_text(content: &str) -> String {
    let normalized: String = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let characters: Vec<char> = normalized.chars().collect();
    if characters.len() > 240 {
        let head: String = characters.into_iter().take(240).collect();
        format!("{head}…")
    } else {
        normalized
    }
}

/// 收集历史中命中模式的条目（去重、压缩、上限 8 条），与 web `collectHistoryItems` 同构。
fn collect_history_items(history: &[String], pattern: &Regex) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for content in history {
        let mut lines: Vec<String> = content
            .split('\n')
            .map(|line| line.trim_end_matches('\r').trim())
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect();
        let candidates: Vec<String> = if lines.len() > 1 {
            lines.clone()
        } else {
            vec![content.split_whitespace().collect::<Vec<_>>().join(" ")]
        };
        lines.clear();
        for candidate in candidates {
            if !pattern.is_match(&candidate) {
                continue;
            }
            let value = compact_history_text(&candidate);
            if value.is_empty() || seen.contains(&value) {
                continue;
            }
            seen.insert(value.clone());
            items.push(value);
            if items.len() >= MAX_PRESERVED_HISTORY_ITEMS {
                return items;
            }
        }
    }
    items
}

fn preserved_history_block(history: &[String]) -> Option<ContextBlock> {
    let constraints = collect_history_items(history, constraint_pattern());
    let todos = collect_history_items(history, todo_pattern());
    if constraints.is_empty() && todos.is_empty() {
        return None;
    }
    let mut sections = vec!["[压缩历史中保留的用户约束与待办]".to_owned()];
    if !constraints.is_empty() {
        let body = constraints
            .iter()
            .map(|item| format!("- {item}"))
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("约束：\n{body}"));
    }
    if !todos.is_empty() {
        let body = todos
            .iter()
            .map(|item| format!("- {item}"))
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("待办：\n{body}"));
    }
    let mut block = make_block(
        "history-preserved".to_owned(),
        "history",
        sections.join("\n"),
        true,
    );
    block.compressed = true;
    Some(block)
}

/// 历史候选：≤12 条原样；>12 条压缩为首二 + 保留块 + 中间摘要 + 尾四。
fn history_candidates(history: &[String]) -> (Vec<ContextBlock>, bool) {
    if history.len() <= HISTORY_COMPRESSION_THRESHOLD {
        return (
            history
                .iter()
                .enumerate()
                .map(|(index, content)| {
                    make_block(format!("history-{}", index + 1), "history", content.clone(), true)
                })
                .collect(),
            false,
        );
    }
    let head: Vec<ContextBlock> = history
        .iter()
        .take(2)
        .enumerate()
        .map(|(index, content)| {
            make_block(format!("history-{}", index + 1), "history", content.clone(), true)
        })
        .collect();
    let tail_start = history.len() - 4;
    let tail: Vec<ContextBlock> = history[tail_start..]
        .iter()
        .enumerate()
        .map(|(index, content)| {
            make_block(
                format!("history-{}", tail_start + index + 1),
                "history",
                content.clone(),
                true,
            )
        })
        .collect();
    let preserved = preserved_history_block(history);
    let middle = history[2..tail_start]
        .iter()
        .enumerate()
        .map(|(index, content)| format!("{}. {}", index + 1, compact_history_text(content)))
        .collect::<Vec<_>>()
        .join("\n");
    let mut summary = make_block(
        "history-compressed".to_owned(),
        "history",
        format!("[中间历史已压缩，保留 {} 条摘要]\n{}", history.len() - 6, middle),
        true,
    );
    summary.compressed = true;
    let mut blocks = head;
    if let Some(preserved) = preserved {
        blocks.push(preserved);
    }
    blocks.push(summary);
    blocks.extend(tail);
    (blocks, true)
}

/// 预算裁剪：放不下整块丢弃；能放一部分则截断加标记（对齐 web `fitBlock`）。
fn fit_block(candidate: ContextBlock, remaining_tokens: Option<usize>) -> Option<ContextBlock> {
    let Some(remaining) = remaining_tokens else {
        return Some(candidate);
    };
    if remaining == 0 {
        return None;
    }
    let available_chars = remaining.saturating_mul(4);
    if utf16_len(&candidate.content) <= available_chars {
        return Some(candidate);
    }
    let marker_units = utf16_len(TRUNCATION_MARKER);
    let content = if available_chars <= marker_units {
        utf16_truncate(TRUNCATION_MARKER, available_chars)
    } else {
        format!(
            "{}{}",
            utf16_truncate(&candidate.content, available_chars - marker_units),
            TRUNCATION_MARKER
        )
    };
    let mut fitted = candidate;
    fitted.content = content;
    fitted.truncated = true;
    Some(fitted)
}

pub struct ContextComposer;

impl ContextComposer {
    /// 稳定块序 + 逐块预算截断（行为与 web `buildAiContext` 逐字节同构，夹具互证）。
    pub fn compose(input: &ComposerInput) -> ContextPackage {
        let mut candidates: Vec<ContextBlock> = Vec::new();
        for (index, content) in input.system.iter().enumerate() {
            candidates.push(make_block(
                format!("system-{}", index + 1),
                "system",
                content.clone(),
                true,
            ));
        }
        for (name, serialized) in &input.tools {
            candidates.push(make_block(
                format!("tool-{name}"),
                "tool",
                serialized.clone(),
                true,
            ));
        }
        for (index, content) in input.memory.iter().enumerate() {
            candidates.push(make_block(
                format!("memory-{}", index + 1),
                "memory",
                content.clone(),
                true,
            ));
        }
        for (index, item) in input.retrieval.iter().enumerate() {
            candidates.push(make_block(
                item.id.clone().unwrap_or_else(|| format!("retrieval-{}", index + 1)),
                "retrieval",
                item.content.clone(),
                false,
            ));
        }
        let (history_blocks, compressed) = history_candidates(&input.history);
        candidates.extend(history_blocks);
        for (index, content) in input.attachments.iter().enumerate() {
            candidates.push(make_block(
                format!("attachment-{}", index + 1),
                "attachment",
                content.clone(),
                false,
            ));
        }
        for (index, item) in input.external.iter().enumerate() {
            candidates.push(make_block(
                item.id.clone().unwrap_or_else(|| format!("external-{}", index + 1)),
                "external",
                item.content.clone(),
                false,
            ));
        }

        let budget_tokens = input.max_tokens.filter(|value| *value > 0);
        let mut blocks = Vec::new();
        let mut remaining = budget_tokens;
        let mut truncated = false;
        for candidate in candidates {
            let Some(fitted) = fit_block(candidate, remaining) else {
                truncated = true;
                continue;
            };
            let was_truncated = fitted.truncated;
            let cost = estimate_tokens(&fitted.content);
            blocks.push(fitted);
            if was_truncated {
                truncated = true;
            }
            if let Some(available) = remaining.as_mut() {
                *available = available.saturating_sub(cost);
            }
        }
        let estimated_tokens = blocks.iter().map(|block| estimate_tokens(&block.content)).sum();
        ContextPackage {
            blocks,
            budget_tokens,
            estimated_tokens,
            truncated,
            compressed_history: compressed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ComposerInput, ContextComposer, ContextPackage, ExternalItem, RetrievalItem};
    use serde_json::Value;

    /// 双侧共享夹具：与 web/test/ai-context.test.mjs 读同一份 JSON，逐字节互证。
    #[test]
    fn composer_is_byte_compatible_with_web_contract() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/context-serialization.json"
        );
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap())
            .expect("夹具必须是合法 JSON");
        for case in fixture["cases"].as_array().expect("cases 数组") {
            let name = case["name"].as_str().unwrap_or("?");
            let package = compose_from_fixture(&case["input"], case["maxTokens"].as_u64());
            let expected = &case["expected"];
            assert_eq!(
                package.serialized(),
                expected["serialized"].as_str().unwrap_or(""),
                "{name}: serialized 与 web 契约不一致"
            );
            let ids: Vec<&str> = package
                .blocks
                .iter()
                .map(|block| block.id.as_str())
                .collect();
            let expected_ids: Vec<&str> = expected["blockIds"]
                .as_array()
                .map(|items| items.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            assert_eq!(ids, expected_ids, "{name}: 块序与 web 契约不一致");
            assert_eq!(
                package.truncated,
                expected["truncated"].as_bool().unwrap_or(false),
                "{name}: truncated 标志不一致"
            );
            assert_eq!(
                package.compressed_history,
                expected["compressedHistory"].as_bool().unwrap_or(false),
                "{name}: compressedHistory 标志不一致"
            );
            assert_eq!(
                package.estimated_tokens,
                expected["estimatedTokens"].as_u64().unwrap_or(0) as usize,
                "{name}: estimatedTokens 不一致"
            );
        }
    }

    fn compose_from_fixture(input: &Value, max_tokens: Option<u64>) -> ContextPackage {
        let strings = |key: &str| -> Vec<String> {
            input[key]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        };
        let composer_input = ComposerInput {
            system: strings("system"),
            tools: input["tools"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|tool| {
                            Some((
                                tool["name"].as_str()?.to_owned(),
                                tool["serialized"].as_str()?.to_owned(),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default(),
            memory: strings("memory"),
            retrieval: input["retrieval"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| RetrievalItem {
                            id: item["id"].as_str().map(str::to_owned),
                            content: item["content"].as_str().unwrap_or_default().to_owned(),
                            citation_id: item["citationId"].as_str().map(str::to_owned),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            history: strings("history"),
            attachments: strings("attachments"),
            external: input["external"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| ExternalItem {
                            id: item["id"].as_str().map(str::to_owned),
                            content: item["content"].as_str().unwrap_or_default().to_owned(),
                            provider: item["provider"].as_str().map(str::to_owned),
                            origin: item["origin"].as_str().map(str::to_owned),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            max_tokens: max_tokens.map(|value| value as usize),
        };
        ContextComposer::compose(&composer_input)
    }
}
