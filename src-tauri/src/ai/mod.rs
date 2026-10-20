//! AI 专用检索边界。
//!
//! 这里的检索结果只来自已经通过 SQL 权限路径过滤的本地索引。返回给模型的
//! 内容统一标记为 `trusted = false`，并且按 Markdown 段落拆成可引用块，避免
//! 把检索正文误当成系统指令或让引用退化成整篇文档。

use crate::index::Index;
use serde::{Deserialize, Serialize};

pub(crate) mod embeddings;
mod retrieval;
use retrieval::{fuse_search_results, rerank_search_results};

const DEFAULT_LIMIT: usize = 12;
const MAX_LIMIT: usize = 50;
const DEFAULT_BLOCK_CHARS: usize = 1600;
const MAX_BLOCK_CHARS: usize = 4000;
const MAX_BLOCKS_PER_NOTE: usize = 4;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRetrievalRequest {
    pub query: String,
    /// Optional rewritten/sub-question queries. The original `query` remains
    /// the stable request identity and is used when this field is absent.
    pub queries: Option<Vec<String>>,
    pub limit: Option<usize>,
    pub folder_id: Option<String>,
    pub inbox_status: Option<String>,
    /// 已授权的 Vault 相对路径。`Some([])` 明确表示无权访问任何文档。
    pub allowed_paths: Option<Vec<String>>,
    pub max_block_chars: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRetrievalResponse {
    pub query: String,
    pub queries: Vec<String>,
    pub strategy: &'static str,
    pub permission_filtered: bool,
    pub blocks: Vec<AiRetrievalBlock>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRetrievalBlock {
    pub citation_id: String,
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub content: String,
    pub excerpt: String,
    pub anchor: String,
    pub rank: usize,
    pub score: f32,
    pub source: &'static str,
    pub sources: Vec<String>,
    pub trusted: bool,
    pub updated_at: Option<String>,
}

pub fn retrieve(index: &Index, request: AiRetrievalRequest) -> Result<AiRetrievalResponse, String> {
    let query = request.query.trim().to_owned();
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let max_block_chars = request
        .max_block_chars
        .unwrap_or(DEFAULT_BLOCK_CHARS)
        .clamp(240, MAX_BLOCK_CHARS);
    let allowed_paths = request
        .allowed_paths
        .ok_or_else(|| "AI 检索必须显式提供权限范围".to_owned())?;
    let queries = normalize_queries(&query, request.queries);
    let mut recalls = Vec::with_capacity(queries.len());
    for search_query in &queries {
        recalls.push(index.search_query_sources_with_allowed_paths(
            search_query,
            limit,
            request.folder_id.as_deref(),
            request.inbox_status.as_deref(),
            Some(&allowed_paths),
        )?);
    }
    let source_slices = recalls
        .iter()
        .flat_map(|recall| {
            [
                ("fts5", recall.fts.as_slice()),
                ("like", recall.like.as_slice()),
                ("vector", recall.vector.as_slice()),
            ]
        })
        .collect::<Vec<_>>();
    let rerank_query = queries.join(" ");
    let fused = rerank_search_results(
        fuse_search_results(&source_slices, limit),
        &rerank_query,
        limit,
    );

    let mut blocks = Vec::new();
    for (note_rank, fused_item) in fused.iter().enumerate() {
        let item = &fused_item.item;
        let Some((note_id, title, content)) = index.note_content(&item.file_path)? else {
            continue;
        };
        let note_blocks = split_blocks(&content, &rerank_query, max_block_chars);
        for (block_index, (anchor, block_content)) in note_blocks.into_iter().enumerate() {
            let rank = note_rank * MAX_BLOCKS_PER_NOTE + block_index + 1;
            let excerpt = compact_excerpt(&block_content, 240);
            blocks.push(AiRetrievalBlock {
                citation_id: format!("cite-{rank}"),
                note_id: note_id.clone(),
                path: item.file_path.clone(),
                title: title.clone(),
                content: block_content,
                excerpt,
                anchor,
                rank,
                score: fused_item.score,
                source: "local-index",
                sources: fused_item.sources.clone(),
                trusted: false,
                updated_at: item.updated_at.clone(),
            });
        }
    }

    Ok(AiRetrievalResponse {
        query,
        queries,
        strategy: if recalls.iter().any(|recall| !recall.vector.is_empty()) {
            "hybrid-rrf-vector"
        } else if recalls.iter().any(|recall| recall.fts_attempted) {
            "hybrid-rrf"
        } else {
            "like"
        },
        permission_filtered: true,
        blocks,
    })
}

fn normalize_queries(original: &str, requested: Option<Vec<String>>) -> Vec<String> {
    let mut queries = requested
        .unwrap_or_default()
        .into_iter()
        .map(|query| query.trim().to_owned())
        .filter(|query| !query.is_empty())
        .take(4)
        .collect::<Vec<_>>();
    if queries.is_empty() {
        queries.push(original.to_owned());
    }
    queries
}

fn split_blocks(content: &str, query: &str, max_chars: usize) -> Vec<(String, String)> {
    let paragraphs = content
        .split("\n\n")
        .enumerate()
        .filter_map(|(index, value)| {
            let value = value.trim();
            (!value.is_empty()).then(|| (index, value.to_owned()))
        })
        .collect::<Vec<_>>();
    let mut ordered = paragraphs;
    let query_lower = query.to_lowercase();
    if !query.is_empty() {
        ordered.sort_by_key(|(_, value)| {
            if value.to_lowercase().contains(&query_lower) {
                0
            } else {
                1
            }
        });
    }
    ordered
        .into_iter()
        .take(MAX_BLOCKS_PER_NOTE)
        .map(|(original_index, value)| {
            let heading = value
                .lines()
                .find(|line| line.trim_start().starts_with('#'))
                .map(|line| line.trim().trim_start_matches('#').trim().to_owned())
                .filter(|line| !line.is_empty())
                .unwrap_or_else(|| format!("段落 {}", original_index + 1));
            (heading, truncate_chars(&value, max_chars))
        })
        .collect()
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn compact_excerpt(value: &str, max_chars: usize) -> String {
    truncate_chars(
        &value.split_whitespace().collect::<Vec<_>>().join(" "),
        max_chars,
    )
}

#[cfg(test)]
mod tests {
    use super::{AiRetrievalRequest, retrieve, split_blocks};
    use crate::index::Index;
    use crate::vault::Vault;

    #[test]
    fn split_blocks_prioritizes_matching_paragraphs_and_keeps_anchor() {
        let blocks = split_blocks("# 总览\n\n普通内容\n\n权限过滤内容", "权限过滤", 100);
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].0, "段落 3");
        assert!(blocks[0].1.contains("权限过滤内容"));
    }

    #[test]
    fn split_blocks_caps_each_block_without_losing_block_boundary() {
        let blocks = split_blocks("一二三四五六七八九十", "", 4);
        assert_eq!(blocks[0].1, "一二三四…");
    }

    #[test]
    fn retrieve_fuses_sources_after_permission_filtering() {
        let directory = tempfile::tempdir().unwrap();
        let vault = Vault::open(directory.path().into()).unwrap();
        vault
            .write("allowed.md", "# 允许\n\n权限测试内容", None)
            .unwrap();
        vault
            .write("hidden.md", "# 隐藏\n\n权限测试内容", None)
            .unwrap();
        let index = Index::open(vault.root()).unwrap();
        index.scan(&vault).unwrap();

        let response = retrieve(
            &index,
            AiRetrievalRequest {
                query: "权限测试".to_owned(),
                queries: Some(vec!["权限测试".to_owned(), "权限测试内容".to_owned()]),
                limit: Some(10),
                folder_id: None,
                inbox_status: None,
                allowed_paths: Some(vec!["allowed.md".to_owned()]),
                max_block_chars: Some(400),
            },
        )
        .unwrap();

        assert_eq!(response.strategy, "hybrid-rrf-vector");
        assert_eq!(response.queries.len(), 2);
        assert!(response.permission_filtered);
        assert!(!response.blocks.is_empty());
        assert!(
            response
                .blocks
                .iter()
                .all(|block| block.path == "allowed.md")
        );
        assert!(
            response
                .blocks
                .iter()
                .all(|block| block.sources == vec!["fts5", "like", "vector"])
        );
        assert!(response.blocks.iter().all(|block| !block.trusted));
    }
}
