//! 索引层：SQLite 投影 + FTS5 trigram 全文检索 + 增量扫描。
//!
//! 设计要点（对齐架构说明书 Phase 1）：
//! - **磁盘 Markdown 是唯一真源**，这里只是可随时删除重建的投影；
//! - 增量对齐靠 `(size, modified_at)` 比对，未变化的文件**完全不读盘**；
//! - 检索优先 FTS5 `MATCH`（trigram 分词，中文子串可命中），
//!   短于 3 字符的查询以及 FTS 未命中时走 `LIKE` 兜底 —— 与原项目两条路径一致。

use crate::ai::embeddings;
use crate::db;
use crate::markdown::{
    compute_word_count, extract_note_tags, extract_wiki_links, parse_frontmatter, strip_frontmatter,
};
use crate::time::{iso8601_utc, now_millis};
use crate::vault::{NoteFile, Vault, title_from_markdown};
use rusqlite::types::ToSql;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// trigram 分词器按 3 字符滑窗建索引，短于此长度的查询交给 LIKE 兜底。
const TRIGRAM_MIN_CHARS: usize = 3;
/// 摘要命中的上下文窗口（字符），前后各取一半。
const EXCERPT_WINDOW: usize = 60;

pub struct Index {
    connection: Mutex<Connection>,
    database: PathBuf,
}

struct NoteListRow {
    id: String,
    title: String,
    content: String,
    folder_id: Option<String>,
    is_pinned: bool,
    file_path: String,
    word_count: u64,
    content_hash: Option<String>,
    properties_json: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

fn note_properties(raw: Option<&str>) -> Value {
    raw.and_then(|text| serde_json::from_str::<Value>(text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn note_tags(connection: &Connection, path: &str) -> Vec<Value> {
    let Ok(mut statement) = connection.prepare(
        "SELECT t.id, t.name, COUNT(nt2.note_path) FROM note_tags nt
         JOIN tags t ON t.id = nt.tag_id
         LEFT JOIN note_tags nt2 ON nt2.tag_id = t.id
         WHERE nt.note_path = ?1 GROUP BY t.id, t.name ORDER BY t.name COLLATE NOCASE ASC",
    ) else {
        return Vec::new();
    };
    statement
        .query_map(params![path], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "noteCount": row.get::<_, i64>(2)?,
            }))
        })
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .collect()
}

fn relation_count(connection: &Connection, column: &str, id: &str) -> u64 {
    let sql = format!("SELECT COUNT(*) FROM links WHERE {column} = ?1");
    connection
        .query_row(&sql, params![id], |row| row.get::<_, i64>(0))
        .unwrap_or(0) as u64
}

fn excerpt(content: &str) -> String {
    let text = content.split_whitespace().collect::<Vec<_>>().join(" ");
    text.chars().take(140).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
    /// 读取失败而跳过的文件（超过 8MB 上限、非 UTF-8 等），不阻断整次扫描。
    pub skipped: usize,
    pub total: usize,
    pub duration_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMatch {
    pub path: String,
    pub title: String,
    pub bytes: u64,
    pub modified_at: Option<i64>,
    pub excerpt: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub notes: usize,
    pub db_bytes: u64,
}

impl Index {
    /// 打开（必要时创建）Vault 内的索引库：`<vault>/.lattice/lattice.db`。
    pub fn open(root: &Path) -> Result<Self, String> {
        let database = root.join(".lattice").join("lattice.db");
        let connection = db::open(&database)?;
        embeddings::backfill(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            database,
        })
    }

    /// 增量同步：与文件系统对齐，返回本次扫描的统计。
    pub fn scan(&self, vault: &Vault) -> Result<ScanSummary, String> {
        let started = Instant::now();
        let files = vault.scan_files()?;
        let on_disk: HashSet<&str> = files.iter().map(|file| file.path.as_str()).collect();

        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        let existing = load_metadata(&connection)?;
        let indexed_at = iso8601_utc(now_millis());

        let mut summary = ScanSummary {
            added: 0,
            updated: 0,
            removed: 0,
            unchanged: 0,
            skipped: 0,
            total: 0,
            duration_ms: 0,
        };

        {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("无法开启索引事务：{error}"))?;

            for file in &files {
                let unchanged = existing
                    .get(&file.path)
                    .map(|(size, modified)| {
                        *size == file.bytes as i64 && *modified == file.modified_at
                    })
                    .unwrap_or(false);
                if unchanged {
                    summary.unchanged += 1;
                    continue;
                }
                let note = match vault.read(&file.path) {
                    Ok(note) => note,
                    Err(_) => {
                        summary.skipped += 1;
                        continue;
                    }
                };
                write_row(
                    &transaction,
                    &note.path,
                    &note.raw,
                    &note.sha256,
                    file.bytes,
                    file.modified_at,
                    &indexed_at,
                )?;
                if existing.contains_key(&file.path) {
                    summary.updated += 1;
                } else {
                    summary.added += 1;
                }
            }

            for path in existing.keys() {
                if !on_disk.contains(path.as_str()) {
                    transaction
                        .execute("DELETE FROM note_tags WHERE note_path = ?1", params![path])
                        .map_err(|error| format!("无法清理标签关联：{error}"))?;
                    embeddings::remove_note_embedding(&transaction, path)?;
                    transaction
                        .execute("DELETE FROM notes WHERE path = ?1", params![path])
                        .map_err(|error| format!("无法清理索引：{error}"))?;
                    summary.removed += 1;
                }
            }

            transaction
                .commit()
                .map_err(|error| format!("无法提交索引事务：{error}"))?;
        }

        summary.total = count_notes(&connection)?;
        summary.duration_ms = started.elapsed().as_millis() as u64;
        Ok(summary)
    }

    /// 单篇零延迟同步：写入笔记后立刻刷新索引行与 FTS。
    pub fn upsert(
        &self,
        path: &str,
        raw: &str,
        hash: &str,
        size: u64,
        modified_at: Option<i64>,
    ) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        write_row(
            &connection,
            path,
            raw,
            hash,
            size,
            modified_at,
            &iso8601_utc(now_millis()),
        )
    }

    /// 列表只走索引，不读盘；最近修改的在前。
    pub fn list(&self) -> Result<Vec<NoteFile>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare("SELECT path, title, size, modified_at FROM notes ORDER BY modified_at DESC, path ASC")
            .map_err(|error| format!("无法查询索引：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(NoteFile {
                    path: row.get(0)?,
                    title: row.get(1)?,
                    bytes: row.get::<_, i64>(2)? as u64,
                    modified_at: row.get(3)?,
                })
            })
            .map_err(|error| format!("无法查询索引：{error}"))?;
        let mut notes = Vec::new();
        for row in rows {
            notes.push(row.map_err(|error| format!("无法读取索引行：{error}"))?);
        }
        Ok(notes)
    }

    /// 全文检索：FTS5 trigram 优先，短查询或未命中走 LIKE 兜底。
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<NoteMatch>, String> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 200 {
            return Err("Search query must contain 1-200 characters".into());
        }
        let limit = limit.clamp(1, 200) as i64;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;

        let mut matches = Vec::new();
        if query.chars().count() >= TRIGRAM_MIN_CHARS {
            match full_text_search(&connection, query, limit, None, None) {
                Ok(found) => matches = found,
                // FTS 异常（短语语法、索引损坏）不该让搜索整体失败，
                // 降级到 LIKE 仍然能给出结果。
                Err(error) => log::warn!("FTS5 检索失败，回退 LIKE 兜底：{error}"),
            }
        }
        if matches.is_empty() {
            matches = like_search(&connection, query, limit, None, None)?;
        }
        Ok(matches)
    }

    pub fn stats(&self) -> Result<IndexStats, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let notes = count_notes(&connection)?;
        drop(connection);

        let db_bytes = ["", "-wal", "-shm"]
            .iter()
            .filter_map(|suffix| {
                let path = PathBuf::from(format!("{}{suffix}", self.database.display()));
                std::fs::metadata(path).ok().map(|meta| meta.len())
            })
            .sum();
        Ok(IndexStats { notes, db_bytes })
    }

    /// 契约 GET /api/search 的对应命令 search_query：
    /// `{strategy, items}`，strategy ∈ fts/like/like-fallback（对齐 Express 语义），
    /// items 为 mapRow 形状。与既有 vault_search（NativeWorkspace 契约）互不影响。
    pub fn search_query(
        &self,
        query: &str,
        limit: usize,
        folder_id: Option<&str>,
        inbox_status: Option<&str>,
    ) -> Result<SearchOutcome, String> {
        self.search_query_with_allowed_paths(query, limit, folder_id, inbox_status, None)
    }

    /// AI 专用检索入口：允许调用方在 SQL 召回阶段提供已授权路径集合。
    /// `Some(&[])` 表示没有可见路径，必须返回空结果，而不是退化为全库搜索。
    pub fn search_query_with_allowed_paths(
        &self,
        query: &str,
        limit: usize,
        folder_id: Option<&str>,
        inbox_status: Option<&str>,
        allowed_paths: Option<&[String]>,
    ) -> Result<SearchOutcome, String> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 200 {
            return Err("Search query must contain 1-200 characters".into());
        }
        if folder_id.is_some_and(|value| value.len() > 64) {
            return Err("Folder ID must contain at most 64 characters".into());
        }
        if inbox_status
            .is_some_and(|value| !matches!(value, "all" | "captured" | "processing" | "processed"))
        {
            return Err("Invalid inbox status".into());
        }
        if allowed_paths.is_some_and(|paths| paths.iter().any(|path| path.len() > 1024)) {
            return Err("Allowed path must contain at most 1024 characters".into());
        }
        let limit = limit.clamp(1, 100);
        let search_limit = if inbox_status.is_some() {
            limit.saturating_mul(6).clamp(100, 200)
        } else {
            limit
        } as i64;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;

        let mut strategy = "like";
        let mut matches: Vec<NoteMatch> = Vec::new();
        let mut fts_attempted = false;
        if query.chars().count() >= TRIGRAM_MIN_CHARS {
            fts_attempted = true;
            match full_text_search(&connection, query, search_limit, folder_id, allowed_paths) {
                Ok(found) => matches = found,
                Err(error) => log::warn!("FTS5 检索失败，回退 LIKE 兜底：{error}"),
            }
        }
        if matches.is_empty() {
            matches = like_search(&connection, query, search_limit, folder_id, allowed_paths)?;
            if fts_attempted {
                strategy = "like-fallback";
            }
        } else {
            strategy = "fts";
        }

        let mut items = Vec::with_capacity(matches.len());
        for note_match in matches {
            let detail = connection
                .query_row(
                    "SELECT COALESCE(note_id, path), folder_id, is_pinned, content_hash, properties_json, updated_at
                     FROM notes WHERE path = ?1",
                    params![note_match.path],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, i64>(2)? != 0,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, Option<String>>(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("无法读取检索行：{error}"))?;
            if let Some((id, folder_id, is_pinned, content_hash, properties_json, updated_at)) =
                detail
            {
                let properties = properties_value(properties_json.as_deref());
                let is_inbox_match = inbox_status.is_none_or(|status| {
                    properties["type"] == serde_json::json!("inbox")
                        && (status == "all" || properties["status"] == serde_json::json!(status))
                });
                if !is_inbox_match {
                    continue;
                }
                items.push(SearchItem {
                    id,
                    title: note_match.title,
                    folder_id,
                    file_path: note_match.path,
                    is_pinned,
                    content_hash,
                    properties_json,
                    updated_at,
                    excerpt: note_match.excerpt,
                });
                if items.len() >= limit {
                    break;
                }
            }
        }
        Ok(SearchOutcome { strategy, items })
    }

    /// AI 混合检索使用的双路召回：FTS5 和 LIKE 都在权限路径与结构化条件
    /// 已生效后执行，交给上层做 RRF 融合。普通 `/search` 仍保持单路策略语义。
    pub fn search_query_sources_with_allowed_paths(
        &self,
        query: &str,
        limit: usize,
        folder_id: Option<&str>,
        inbox_status: Option<&str>,
        allowed_paths: Option<&[String]>,
    ) -> Result<SearchRecall, String> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 200 {
            return Err("Search query must contain 1-200 characters".into());
        }
        if folder_id.is_some_and(|value| value.len() > 64) {
            return Err("Folder ID must contain at most 64 characters".into());
        }
        if inbox_status
            .is_some_and(|value| !matches!(value, "all" | "captured" | "processing" | "processed"))
        {
            return Err("Invalid inbox status".into());
        }
        if allowed_paths.is_some_and(|paths| paths.iter().any(|path| path.len() > 1024)) {
            return Err("Allowed path must contain at most 1024 characters".into());
        }

        let limit = limit.clamp(1, 100);
        // 每路多取一些候选，避免结构化过滤、去重或融合后结果不足。
        let search_limit = limit.saturating_mul(4).clamp(20, 200) as i64;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let fts_attempted = query.chars().count() >= TRIGRAM_MIN_CHARS;
        let fts = if fts_attempted {
            match full_text_search(&connection, query, search_limit, folder_id, allowed_paths) {
                Ok(matches) => {
                    collect_search_items(&connection, matches, search_limit as usize, inbox_status)?
                }
                Err(error) => {
                    log::warn!("AI FTS5 召回失败，仍保留 LIKE 召回：{error}");
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        let like = like_search(&connection, query, search_limit, folder_id, allowed_paths)
            .and_then(|matches| {
                collect_search_items(&connection, matches, search_limit as usize, inbox_status)
            })?;
        let vector = vector_search(&connection, query, search_limit, folder_id, allowed_paths)
            .and_then(|matches| {
                collect_search_items(&connection, matches, search_limit as usize, inbox_status)
            })
            .unwrap_or_else(|error| {
                log::warn!("AI 向量召回失败，保留 FTS/LIKE 结果：{error}");
                Vec::new()
            });

        Ok(SearchRecall {
            fts,
            like,
            vector,
            fts_attempted,
        })
    }

    /// 读取索引中的正文副本，为 AI 块级引用提供精确来源；不绕过 Vault 写入边界。
    pub fn note_content(&self, path: &str) -> Result<Option<(String, String, String)>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection
            .query_row(
                "SELECT COALESCE(note_id, path), title, content FROM notes WHERE path = ?1",
                params![path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("无法读取 AI 检索正文：{error}"))
    }

    /// 相关笔记：复用本地 FTS/LIKE/向量投影，返回笔记级结果，不返回正文。
    ///
    /// 当前桌面端没有独立的 embedding provider 会话，因此查询使用标题作为稳定
    /// 的本地召回锚点；向量投影可用时会自然参与同一轮召回，失败则退回关键词。
    pub fn related_notes(&self, note_id: &str, limit: usize) -> Result<Vec<AiRelatedNote>, String> {
        let (title, content) = {
            let connection = self.connection.lock().map_err(|error| error.to_string())?;
            connection
                .query_row(
                    "SELECT title, content FROM notes
                     WHERE note_id = ?1 OR (note_id IS NULL AND path = ?1)",
                    params![note_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|error| format!("无法读取相关笔记源：{error}"))?
                .ok_or_else(|| "笔记不存在".to_owned())?
        };
        let mut queries = suggestion_terms(&title).into_iter().take(4).collect::<Vec<_>>();
        if queries.is_empty() {
            queries = content
                .split_whitespace()
                .take(12)
                .map(str::to_owned)
                .collect();
        }
        if queries.is_empty() {
            return Ok(Vec::new());
        }

        let mut candidates: HashMap<String, (SearchItem, f32)> = HashMap::new();
        for query in queries {
            let recall = self.search_query_sources_with_allowed_paths(
                &query,
                limit.saturating_mul(4).clamp(12, 100),
                None,
                None,
                None,
            )?;
            for (items, weight) in [
                (recall.vector, 1.0_f32),
                (recall.fts, 0.82_f32),
                (recall.like, 0.64_f32),
            ] {
                for (rank, item) in items.into_iter().enumerate() {
                if item.id == note_id {
                    continue;
                }
                    let score = weight / (rank as f32 + 1.0);
                    candidates
                        .entry(item.id.clone())
                        .and_modify(|(_, current)| *current += score)
                        .or_insert((item, score));
                }
            }
        }
        let mut values = candidates.into_values().collect::<Vec<_>>();
        values.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.0.title.to_lowercase().cmp(&right.0.title.to_lowercase()))
        });
        Ok(values
            .into_iter()
            .take(limit.clamp(1, 12))
            .map(|(item, score)| AiRelatedNote {
                id: item.id,
                title: item.title,
                file_path: item.file_path,
                score: score.min(1.0),
                anchor: Some(item.excerpt),
            })
            .collect())
    }

    /// 双链与标签建议。所有候选均来自本地索引中的既有标题和标签词表，
    /// 接受建议仍由前端追加到草稿，不在此处写入笔记。
    pub fn ai_suggestions(&self, note_id: &str, limit: usize) -> Result<Value, String> {
        let (title, content, excluded_ids, excluded_titles, existing_tags, tag_candidates) = {
            let connection = self.connection.lock().map_err(|error| error.to_string())?;
            let note = connection
                .query_row(
                    "SELECT COALESCE(note_id, path), path, title, content FROM notes
                     WHERE note_id = ?1 OR (note_id IS NULL AND path = ?1)",
                    params![note_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("无法读取建议源笔记：{error}"))?
                .ok_or_else(|| "笔记不存在".to_owned())?;
            let mut excluded_ids = HashSet::from([note.0.clone()]);
            let mut excluded_titles = HashSet::from([note.2.to_lowercase()]);
            let mut link_statement = connection
                .prepare("SELECT target_title, target_note_id FROM links WHERE source_note_id = ?1")
                .map_err(|error| format!("无法读取笔记出链：{error}"))?;
            let mut links = link_statement.query_map(params![note.0.clone()], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(|error| format!("无法读取笔记出链：{error}"))?;
            while let Some(row) = links.next().transpose().map_err(|error| format!("无法读取笔记出链：{error}"))? {
                let (target_title, target_id) = row;
                excluded_titles.insert(target_title.to_lowercase());
                if let Some(target_id) = target_id {
                    excluded_ids.insert(target_id);
                }
            }
            let mut backlink_statement = connection
                .prepare("SELECT source_note_id FROM links WHERE target_note_id = ?1")
                .map_err(|error| format!("无法读取笔记反链：{error}"))?;
            let mut backlinks = backlink_statement
                .query_map(params![note.0.clone()], |row| row.get::<_, String>(0))
                .map_err(|error| format!("无法读取笔记反链：{error}"))?;
            while let Some(source_id) = backlinks
                .next()
                .transpose()
                .map_err(|error| format!("无法读取笔记反链：{error}"))?
            {
                excluded_ids.insert(source_id);
            }
            let mut existing_tag_statement = connection
                .prepare(
                    "SELECT t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                     WHERE nt.note_path = ?1",
                )
                .map_err(|error| format!("无法读取笔记标签：{error}"))?;
            let existing_tags = existing_tag_statement
                .query_map(params![note.1.clone()], |row| row.get::<_, String>(0))
                .map_err(|error| format!("无法读取笔记标签：{error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("无法读取笔记标签：{error}"))?
                .into_iter()
                .map(|name| name.to_lowercase())
                .collect::<HashSet<_>>();
            let mut tag_statement = connection
                .prepare(
                    "SELECT t.name, COUNT(nt.note_path) AS usage FROM tags t
                     LEFT JOIN note_tags nt ON nt.tag_id = t.id
                     GROUP BY t.id, t.name ORDER BY usage DESC, t.name COLLATE NOCASE ASC
                     LIMIT 200",
                )
                .map_err(|error| format!("无法读取标签词表：{error}"))?;
            let tag_candidates = tag_statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)))
                .map_err(|error| format!("无法读取标签词表：{error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("无法读取标签词表：{error}"))?;
            (
                note.2,
                note.3,
                excluded_ids,
                excluded_titles,
                existing_tags,
                tag_candidates,
            )
        };
        let limit = limit.clamp(1, 10);
        let mut links = Vec::new();
        let mut seen = HashSet::new();
        let mut semantic_available = false;
        for term in suggestion_terms(&title).into_iter().take(4) {
            if links.len() >= limit {
                break;
            }
            let recall = self.search_query_sources_with_allowed_paths(&term, limit * 3, None, None, None)?;
            semantic_available |= !recall.vector.is_empty();
            let mut items = recall.vector;
            items.extend(recall.fts);
            items.extend(recall.like);
            for item in items {
                if links.len() >= limit || excluded_ids.contains(&item.id) || seen.contains(&item.id) {
                    continue;
                }
                if excluded_titles.contains(&item.title.to_lowercase()) {
                    continue;
                }
                seen.insert(item.id.clone());
                links.push(json!({
                    "id": item.id,
                    "title": item.title,
                    "filePath": item.file_path,
                    "score": 0.5,
                    "reason": format!("标题词「{term}」命中"),
                }));
            }
        }

        let lower_title = title.to_lowercase();
        let lower_content = content.to_lowercase();
        let mut tags = tag_candidates
            .into_iter()
            .filter_map(|(name, usage)| {
                let lower_name = name.to_lowercase();
                if existing_tags.contains(&lower_name) {
                    return None;
                }
                let in_title = lower_title.contains(&lower_name);
                let in_content = lower_content.contains(&lower_name);
                if !in_title && !in_content {
                    return None;
                }
                let score = (if in_title { 3.0 } else { 0.0 })
                    + (if in_content { 1.0 } else { 0.0 })
                    + (usage.min(5) as f32 * 0.1);
                Some(json!({
                    "name": name,
                    "score": (score * 100.0).round() / 100.0,
                    "matchedIn": if in_title { "标题" } else { "正文" },
                    "usage": usage,
                }))
            })
            .collect::<Vec<_>>();
        tags.sort_by(|left, right| {
            right["score"]
                .as_f64()
                .partial_cmp(&left["score"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        tags.truncate(limit);
        Ok(json!({ "links": links, "tags": tags, "semanticAvailable": semantic_available }))
    }

    /// 生成每日摘要所需的元数据和短摘录。正文只在本次调用内读取，调用方
    /// 通过 WorkspaceService 写入最终笔记，不把摘要任务内容放入 jobs/checkpoint。
    pub fn digest_notes(&self, date: &str, journal_prefix: &str) -> Result<Vec<DigestNote>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let since = format!("{date}T00:00:00.000Z");
        let escaped_prefix = escape_like(journal_prefix);
        let mut statement = connection
            .prepare(
                "SELECT title, content, word_count, updated_at FROM notes
                 WHERE updated_at >= ?1 AND path NOT LIKE ?2 ESCAPE '\\'
                 ORDER BY updated_at DESC LIMIT 50",
            )
            .map_err(|error| format!("无法查询每日摘要来源：{error}"))?;
        let rows = statement
            .query_map(params![since, format!("{escaped_prefix}/每日摘要%")], |row| {
                let content: String = row.get(1)?;
                Ok(DigestNote {
                    title: row.get(0)?,
                    word_count: row.get::<_, i64>(2)? as u64,
                    updated_at: row.get(3)?,
                    excerpt: compact_digest_excerpt(&content),
                })
            })
            .map_err(|error| format!("无法查询每日摘要来源：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取每日摘要来源：{error}"))
    }

    #[allow(dead_code)] // P1-04 删除/移动命令迁移接线前暂未使用
    pub fn remove(&self, path: &str) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection
            .execute("DELETE FROM note_tags WHERE note_path = ?1", params![path])
            .map_err(|error| format!("无法清理标签关联：{error}"))?;
        embeddings::remove_note_embedding(&connection, path)?;
        connection
            .execute("DELETE FROM notes WHERE path = ?1", params![path])
            .map_err(|error| format!("无法删除索引行：{error}"))?;
        Ok(())
    }

    /// 标签列表（契约 GET /api/tags 的对应命令 tag_list）：
    /// 按 noteCount 倒序、名称 NOCASE 正序，与 Express findAllWithCounts 一致。
    pub fn list_tags(&self) -> Result<Vec<TagEntry>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT t.id, t.name, t.created_at, COUNT(nt.note_path) AS note_count
                 FROM tags t LEFT JOIN note_tags nt ON nt.tag_id = t.id
                 GROUP BY t.id, t.name, t.created_at
                 ORDER BY note_count DESC, t.name COLLATE NOCASE ASC",
            )
            .map_err(|error| format!("无法查询标签：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(TagEntry {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    note_count: row.get::<_, i64>(3)? as u64,
                })
            })
            .map_err(|error| format!("无法查询标签：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取标签行：{error}"))
    }

    pub fn delete_tag(&self, id: &str) -> Result<Value, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tags WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|error| format!("无法查询标签：{error}"))?;
        if exists == 0 {
            return Ok(json!({ "id": id, "deleted": false }));
        }
        connection
            .execute("DELETE FROM note_tags WHERE tag_id = ?1", params![id])
            .and_then(|_| connection.execute("DELETE FROM tags WHERE id = ?1", params![id]))
            .map_err(|error| format!("无法删除标签：{error}"))?;
        Ok(json!({ "id": id, "deleted": true }))
    }

    /// 轻量笔记索引（契约 GET /api/notes/index 对应命令 note_index）：
    /// 图谱、快速切换器、双链解析与嵌入预览共用，不含正文。
    /// folderId 返回 null：folders 表模型随第三批迁移（Δ2）。
    pub fn list_note_index(&self) -> Result<Vec<NoteIndexEntry>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT COALESCE(note_id, path), title, folder_id, is_pinned, path, word_count,
                 content_hash, properties_json, COALESCE(created_at, indexed_at)
                 FROM notes ORDER BY modified_at DESC",
            )
            .map_err(|error| format!("无法查询笔记索引：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                let properties_json: Option<String> = row.get(7)?;
                Ok(NoteIndexEntry {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    folder_id: row.get(2)?,
                    is_pinned: row.get::<_, i64>(3)? != 0,
                    file_path: row.get(4)?,
                    word_count: row.get::<_, i64>(5)? as u64,
                    content_hash: row.get(6)?,
                    properties: properties_value(properties_json.as_deref()),
                    properties_json,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|error| format!("无法查询笔记索引：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取笔记索引行：{error}"))
    }

    /// 分页笔记列表（契约 GET /api/notes）。列表只返回摘要，正文仍由 note_get 读取。
    pub fn list_notes(
        &self,
        folder_id: Option<&str>,
        tag_id: Option<&str>,
        inbox_status: Option<&str>,
        sort: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Value, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT COALESCE(note_id, path), title, content, folder_id, is_pinned, path, word_count,
                 content_hash, properties_json, created_at, updated_at FROM notes",
            )
            .map_err(|error| format!("无法查询笔记列表：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(NoteListRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    folder_id: row.get(3)?,
                    is_pinned: row.get::<_, i64>(4)? != 0,
                    file_path: row.get(5)?,
                    word_count: row.get::<_, i64>(6)? as u64,
                    content_hash: row.get(7)?,
                    properties_json: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(|error| format!("无法查询笔记列表：{error}"))?;
        let mut notes = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取笔记列表：{error}"))?
            .into_iter()
            .filter(|note| {
                let folder_matches = match folder_id {
                    Some("__none__") => note.folder_id.is_none(),
                    Some(value) => note.folder_id.as_deref() == Some(value),
                    None => true,
                };
                let tag_matches = tag_id.is_none_or(|value| {
                    connection
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM note_tags WHERE note_path = ?1 AND tag_id = ?2)",
                            params![note.file_path, value],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap_or(0)
                        != 0
                });
                let properties = note_properties(note.properties_json.as_deref());
                let inbox_matches = match inbox_status {
                    None => true,
                    Some(status) => properties.get("type").and_then(Value::as_str) == Some("inbox")
                        && (status == "all" || properties.get("status").and_then(Value::as_str) == Some(status)),
                };
                folder_matches && tag_matches && inbox_matches
            })
            .collect::<Vec<_>>();
        notes.sort_by(|left, right| {
            right
                .is_pinned
                .cmp(&left.is_pinned)
                .then_with(|| match sort {
                    "created" => right.created_at.cmp(&left.created_at),
                    "title" => left.title.to_lowercase().cmp(&right.title.to_lowercase()),
                    _ => right.updated_at.cmp(&left.updated_at),
                })
        });
        let total = notes.len();
        let items = notes
            .into_iter()
            .skip(offset)
            .take(limit.clamp(1, 200))
            .map(|note| {
                let properties = note_properties(note.properties_json.as_deref());
                let tags = note_tags(&connection, &note.file_path);
                let outgoing_count = relation_count(&connection, "source_note_id", &note.id);
                let backlink_count = relation_count(&connection, "target_note_id", &note.id);
                json!({
                    "id": note.id,
                    "title": note.title,
                    "folderId": note.folder_id,
                    "filePath": note.file_path,
                    "isPinned": note.is_pinned,
                    "wordCount": note.word_count,
                    "contentHash": note.content_hash,
                    "propertiesJson": note.properties_json.unwrap_or_else(|| "{}".to_owned()),
                    "properties": properties,
                    "createdAt": note.created_at,
                    "updatedAt": note.updated_at,
                    "excerpt": excerpt(&note.content),
                    "tags": tags,
                    "outgoingCount": outgoing_count,
                    "backlinkCount": backlink_count,
                })
            })
            .collect::<Vec<_>>();
        Ok(
            json!({ "items": items, "total": total, "limit": limit.clamp(1, 200), "offset": offset }),
        )
    }

    /// review 健康扫描数据（对齐 notesRepository.listForHealth）：全量笔记含正文/属性。
    pub fn list_for_health(&self) -> Result<Vec<HealthNote>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT COALESCE(note_id, path), title, content, path, folder_id, updated_at,
                 created_at, word_count, content_hash, properties_json
                 FROM notes ORDER BY path ASC",
            )
            .map_err(|error| format!("无法查询健康扫描数据：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(HealthNote {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    file_path: row.get(3)?,
                    folder_id: row.get(4)?,
                    updated_at: row.get(5)?,
                    created_at: row.get(6)?,
                    word_count: row.get::<_, i64>(7)?,
                    content_hash: row.get(8)?,
                    properties: row
                        .get::<_, Option<String>>(9)?
                        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                        .filter(|value| value.is_object())
                        .unwrap_or_else(|| serde_json::json!({})),
                })
            })
            .map_err(|error| format!("无法查询健康扫描数据：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取健康扫描数据：{error}"))
    }

    /// 每篇笔记的标签名列表（note_id → names，对齐 tagsRepository.findTagsForNotes）。
    pub fn tags_for_notes(&self) -> Result<HashMap<String, Vec<String>>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT COALESCE(n.note_id, n.path), t.name FROM note_tags nt
                 JOIN notes n ON n.path = nt.note_path
                 JOIN tags t ON t.id = nt.tag_id",
            )
            .map_err(|error| format!("无法查询笔记标签：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("无法查询笔记标签：{error}"))?;
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for row in rows {
            let (note_id, name) = row.map_err(|error| format!("无法读取笔记标签：{error}"))?;
            map.entry(note_id).or_default().push(name);
        }
        Ok(map)
    }

    /// 出链/入链计数（note_id → 条数，对齐 linksService.countsForNotes）。
    pub fn link_counts(&self) -> Result<LinkCountPair, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let count_by = |sql: &str| -> Result<HashMap<String, i64>, String> {
            let mut statement = connection
                .prepare(sql)
                .map_err(|error| format!("无法统计链接：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(|error| format!("无法统计链接：{error}"))?;
            let mut map = HashMap::new();
            for row in rows {
                let (key, count) = row.map_err(|error| format!("无法读取链接计数：{error}"))?;
                map.insert(key, count);
            }
            Ok(map)
        };
        let outgoing =
            count_by("SELECT source_note_id, COUNT(*) FROM links GROUP BY source_note_id")?;
        let incoming = count_by(
            "SELECT target_note_id, COUNT(*) FROM links WHERE target_note_id IS NOT NULL GROUP BY target_note_id",
        )?;
        Ok((outgoing, incoming))
    }

    /// 悬空链接明细（对齐 linksRepository.listDanglingDetails）。
    pub fn dangling_link_details(&self) -> Result<Vec<DanglingLinkDetail>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT l.target_title, l.source_note_id, COALESCE(n.title, ''), COALESCE(n.path, '')
                 FROM links l
                 LEFT JOIN notes n ON COALESCE(n.note_id, n.path) = l.source_note_id
                 WHERE l.target_note_id IS NULL
                 ORDER BY l.target_title COLLATE NOCASE ASC",
            )
            .map_err(|error| format!("无法查询悬空链接：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(DanglingLinkDetail {
                    target_title: row.get(0)?,
                    source_id: row.get(1)?,
                    source_title: row.get(2)?,
                    source_path: row.get(3)?,
                })
            })
            .map_err(|error| format!("无法查询悬空链接：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取悬空链接：{error}"))
    }

    /// 目录树（契约 GET /api/folders 对应命令 folder_tree）：
    /// 以磁盘目录为准派生（含空目录），id 为确定性投影 id，noteCount 为**直属**笔记数
    /// （Express `countNotesGrouped` 同样是 `GROUP BY folder_id`，非递归）。sortOrder 恒 0
    /// （用户排序随 folders 表批次）。
    ///
    /// 排序对齐 Express `repository.findAll`：`ORDER BY sort_order ASC, name COLLATE NOCASE ASC`。
    /// 组树必须**先建全部节点、再统一挂接**：此前是「先 `nodes.remove` 再在剩余节点里找父」，
    /// 而目录按路径升序排列（父路径必然先被移出 map），于是永远找不到父 → **整棵树被拍平成
    /// 一堆根节点**，桌面态目录层级完全丢失。
    pub fn folder_tree(&self, vault: &Vault) -> Result<Vec<FolderNode>, String> {
        let directories = vault.walk_directories()?;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut nodes: HashMap<String, FolderNode> = HashMap::new();
        let attachment_is_note_folder = folder_has_notes(&connection, ATTACHMENT_STORE_DIR)?;
        for directory in directories
            .iter()
            .filter(|directory| is_note_folder(directory, attachment_is_note_folder))
        {
            let name = directory.rsplit('/').next().unwrap_or(directory).to_owned();
            let parent_path = directory
                .rsplit_once('/')
                .map(|(parent, _)| parent.to_owned());
            let direct_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM notes WHERE folder_id = ?1",
                    params![stable_id(directory)],
                    |row| row.get(0),
                )
                .map_err(|error| format!("无法统计目录笔记：{error}"))?;
            let (created_at, updated_at) = directory_timestamps(vault.root(), directory);
            nodes.insert(
                directory.clone(),
                FolderNode {
                    id: stable_id(directory),
                    name,
                    parent_id: parent_path.as_ref().map(|parent| stable_id(parent)),
                    sort_order: 0,
                    note_count: direct_count as u64,
                    children: Vec::new(),
                    created_at,
                    updated_at,
                },
            );
        }
        // Express 的排序键（sortOrder 恒 0 ⇒ 等价于按 name 的 ASCII 不敏感升序；SQLite 的
        // NOCASE 只对 ASCII 折叠大小写、非 ASCII 回落 BINARY，与 Rust 的字节序比较一致）
        let sort_key = |path: &str| path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
        let mut ordered: Vec<String> = nodes.keys().cloned().collect();
        ordered.sort_by(|left, right| {
            sort_key(left)
                .cmp(&sort_key(right))
                .then_with(|| left.cmp(right))
        });
        // 第一趟：节点齐全时先记下「谁挂在谁下面」，不会再出现找不到父的情况
        let mut children_of: HashMap<String, Vec<String>> = HashMap::new();
        let mut root_paths: Vec<String> = Vec::new();
        for path in &ordered {
            match path.rsplit_once('/') {
                Some((parent, _)) if nodes.contains_key(parent) => {
                    children_of
                        .entry(parent.to_owned())
                        .or_default()
                        .push(path.clone());
                }
                _ => root_paths.push(path.clone()),
            }
        }
        // 第二趟：自根向下组装（根与兄弟的相对次序即 ordered 的次序）
        let roots = root_paths
            .iter()
            .map(|path| assemble_folder_node(path, &mut nodes, &children_of))
            .collect();
        Ok(roots)
    }

    /// 契约 GET /api/meta/overview 的对应命令 meta_overview：
    /// 知识库统计 + 悬空链接列表，形状对齐 Express meta.service overview。
    pub fn meta_overview(&self, vault: &Vault) -> Result<MetaOverview, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let note_count = count_notes(&connection)? as u64;
        // 口径 = Express `COUNT(*) FROM folders`：不含附件仓库（见 is_note_folder）
        let attachment_is_note_folder = folder_has_notes(&connection, ATTACHMENT_STORE_DIR)?;
        let folder_count = vault
            .walk_directories()?
            .iter()
            .filter(|directory| is_note_folder(directory, attachment_is_note_folder))
            .count() as u64;
        let tag_count: u64 = connection
            .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("无法统计标签：{error}"))? as u64;
        let link_count: u64 = connection
            .query_row(
                "SELECT COUNT(*) FROM links WHERE target_note_id IS NOT NULL",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("无法统计链接：{error}"))?
            as u64;
        let dangling_count: u64 = connection
            .query_row("SELECT COUNT(DISTINCT target_title COLLATE NOCASE) FROM links WHERE target_note_id IS NULL", [], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("无法统计悬空链接：{error}"))? as u64;
        let total_words: u64 = connection
            .query_row(
                "SELECT COALESCE(SUM(word_count), 0) FROM notes",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("无法统计字数：{error}"))?
            as u64;
        let mut statement = connection
            .prepare(
                "SELECT target_title, COUNT(DISTINCT source_note_id) FROM links
                 WHERE target_note_id IS NULL
                 GROUP BY target_title COLLATE NOCASE
                 ORDER BY COUNT(DISTINCT source_note_id) DESC, target_title COLLATE NOCASE ASC",
            )
            .map_err(|error| format!("无法查询悬空链接：{error}"))?;
        let dangling = statement
            .query_map([], |row| {
                Ok(DanglingLink {
                    target_title: row.get(0)?,
                    reference_count: row.get::<_, i64>(1)? as u64,
                })
            })
            .map_err(|error| format!("无法查询悬空链接：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取悬空链接：{error}"))?;
        Ok(MetaOverview {
            note_count,
            folder_count,
            tag_count,
            link_count,
            dangling_count,
            total_words,
            dangling_links: dangling,
        })
    }

    /// 笔记详情（对齐 Express mapNote 形状）。
    pub fn find_note_detail(
        &self,
        by_id: Option<&str>,
        by_path: Option<&str>,
    ) -> Result<Option<NoteDetail>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let (predicate, value) = match (by_id, by_path) {
            // Notes created outside Lattice may not have a frontmatter id. The
            // list API exposes their path as the stable fallback id, so detail
            // lookup must resolve that same identity.
            (Some(id), _) => (
                "(note_id = ?1 OR (note_id IS NULL AND path = ?1))",
                id.to_owned(),
            ),
            (None, Some(path)) => ("path = ?1", path.to_owned()),
            _ => return Ok(None),
        };
        let sql = format!(
            "SELECT COALESCE(note_id, path), title, content, folder_id, is_pinned, path, word_count,
             content_hash, properties_json, created_at, updated_at FROM notes WHERE {predicate}"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("无法查询笔记详情：{error}"))?;
        let detail = statement
            .query_row(params![value], |row| {
                let properties_json: Option<String> = row.get(8)?;
                Ok(NoteDetail {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    folder_id: row.get(3)?,
                    file_path: Some(row.get(5)?),
                    is_pinned: row.get::<_, i64>(4)? != 0,
                    word_count: row.get::<_, i64>(6)? as u64,
                    content_hash: row.get(7)?,
                    properties: properties_value(properties_json.as_deref()),
                    properties_json,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    // 关系字段需要额外查询，先占位、拿到行之后再填
                    tags: Vec::new(),
                    outgoing: Vec::new(),
                    backlinks: Vec::new(),
                })
            })
            .optional()
            .map_err(|error| format!("无法读取笔记详情：{error}"))?;
        let Some(mut detail) = detail else {
            return Ok(None);
        };
        let path = detail.file_path.clone().unwrap_or_default();
        detail.tags = query_note_tags(&connection, &path)
            .map_err(|error| format!("无法读取笔记标签：{error}"))?;
        detail.outgoing = query_outgoing_links(&connection, &detail.id)
            .map_err(|error| format!("无法读取出链：{error}"))?;
        detail.backlinks = query_backlinks(&connection, &detail.id)
            .map_err(|error| format!("无法读取反链：{error}"))?;
        Ok(Some(detail))
    }

    /// 文件路径占用检查（create 分配路径用）：投影 file_path 是否已被其它行占用。
    pub fn is_path_taken(&self, path: &str) -> Result<bool, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let taken: Option<String> = connection
            .query_row(
                "SELECT path FROM notes WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("无法检查路径占用：{error}"))?;
        Ok(taken.is_some())
    }

    /// 契约 GET /api/graph 的对应命令 graph_build：
    /// 节点=笔记（degree=出链+入链）、边=已解析双链（双保险过滤端点）、
    /// 悬空链接列表与统计，形状对齐 Express graph.service buildGraph。
    pub fn build_graph(&self) -> Result<GraphData, String> {
        let notes = self.list_note_index()?;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;

        let mut outgoing: HashMap<String, u64> = HashMap::new();
        let mut incoming: HashMap<String, u64> = HashMap::new();
        let mut statement = connection
            .prepare("SELECT source_note_id, COUNT(*) FROM links GROUP BY source_note_id")
            .map_err(|error| format!("无法统计出链：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })
            .map_err(|error| format!("无法统计出链：{error}"))?;
        for row in rows {
            let (id, count) = row.map_err(|error| format!("无法读取出链：{error}"))?;
            outgoing.insert(id, count);
        }
        let mut statement = connection
            .prepare(
                "SELECT target_note_id, COUNT(*) FROM links
                 WHERE target_note_id IS NOT NULL GROUP BY target_note_id",
            )
            .map_err(|error| format!("无法统计入链：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })
            .map_err(|error| format!("无法统计入链：{error}"))?;
        for row in rows {
            let (id, count) = row.map_err(|error| format!("无法读取入链：{error}"))?;
            incoming.insert(id, count);
        }

        let nodes: Vec<GraphNode> = notes
            .iter()
            .map(|note| GraphNode {
                id: note.id.clone(),
                title: note.title.clone(),
                folder_id: note.folder_id.clone(),
                is_pinned: note.is_pinned,
                word_count: note.word_count,
                degree: outgoing.get(&note.id).copied().unwrap_or(0)
                    + incoming.get(&note.id).copied().unwrap_or(0),
            })
            .collect();
        let existing: std::collections::HashSet<String> =
            nodes.iter().map(|node| node.id.clone()).collect();

        let mut statement = connection
            .prepare(
                "SELECT DISTINCT source_note_id, target_note_id FROM links
                 WHERE target_note_id IS NOT NULL",
            )
            .map_err(|error| format!("无法查询链接边：{error}"))?;
        let edges: Vec<GraphEdge> = statement
            .query_map([], |row| {
                Ok(GraphEdge {
                    source: row.get(0)?,
                    target: row.get(1)?,
                })
            })
            .map_err(|error| format!("无法查询链接边：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取链接边：{error}"))?
            .into_iter()
            .filter(|edge| existing.contains(&edge.source) && existing.contains(&edge.target))
            .collect();

        let mut statement = connection
            .prepare(
                "SELECT target_title, COUNT(DISTINCT source_note_id) FROM links
                 WHERE target_note_id IS NULL
                 GROUP BY target_title COLLATE NOCASE
                 ORDER BY COUNT(DISTINCT source_note_id) DESC, target_title COLLATE NOCASE ASC",
            )
            .map_err(|error| format!("无法查询悬空链接：{error}"))?;
        let dangling: Vec<DanglingLink> = statement
            .query_map([], |row| {
                Ok(DanglingLink {
                    target_title: row.get(0)?,
                    reference_count: row.get::<_, i64>(1)? as u64,
                })
            })
            .map_err(|error| format!("无法查询悬空链接：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取悬空链接：{error}"))?;

        let edge_count = edges.len() as u64;
        Ok(GraphData {
            dangling,
            stats: GraphStats {
                node_count: nodes.len() as u64,
                edge_count,
                isolated_count: nodes.iter().filter(|node| node.degree == 0).count() as u64,
            },
            nodes,
            edges,
        })
    }
}

/// 笔记详情（对齐 Express mapNote，camelCase 序列化）。
/// 把库里存的 `properties_json` 解析成**对象**。
///
/// Express 在 note 系列响应里**同时**给 `propertiesJson`(string) 与 `properties`(object)；
/// Rust 侧原先只发字符串，前端却按对象消费（`App.tsx` 等读 `note.properties?.type`），
/// 这是 P1-08 差异清单里 note 系的共性缺口。解析失败或无属性时统一给空对象，
/// 保证线缆上的字段类型恒为 object。
fn properties_value(raw: Option<&str>) -> serde_json::Value {
    raw.and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// 库中 NULL 表示「无属性」，而 Express 在**线缆上始终发字符串**（无属性时为 `{}`）。
/// 用自定义序列化在线缆层归一，避免改动 Rust 内部类型（`workspace.rs` 仍按 Option 读取）。
fn serialize_properties_json<S>(value: &Option<String>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(value.as_deref().unwrap_or("{}"))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteDetail {
    pub id: String,
    pub title: String,
    pub content: String,
    pub folder_id: Option<String>,
    pub file_path: Option<String>,
    pub is_pinned: bool,
    pub word_count: u64,
    pub content_hash: Option<String>,
    #[serde(serialize_with = "serialize_properties_json")]
    pub properties_json: Option<String>,
    /// 解析后的属性对象（与 Express 同名字段对齐；`properties_json` 保留兼容既有消费方）
    pub properties: serde_json::Value,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// 关系字段（Express `mapNote` 同形状）：
    /// 标签、出链、反链。由 `find_note_detail` 单独查询后填充。
    pub tags: Vec<NoteTag>,
    pub outgoing: Vec<NoteOutgoingLink>,
    pub backlinks: Vec<NoteBacklink>,
}

/// AI 相关笔记结果：只返回可跳转的元数据和解释性分数，不返回正文。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRelatedNote {
    pub id: String,
    pub title: String,
    pub file_path: String,
    pub score: f32,
    pub anchor: Option<String>,
}

/// 每日摘要的本地来源投影。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestNote {
    pub title: String,
    pub word_count: u64,
    pub updated_at: Option<String>,
    pub excerpt: String,
}

/// 详情里的标签（对齐 Express `findTagsForNotes`：只发 id 与 name）。
#[derive(Serialize, Debug)]
pub struct NoteTag {
    pub id: String,
    pub name: String,
}

/// 出链（对齐 Express `listOutgoing`）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteOutgoingLink {
    pub target_title: String,
    pub target_note_id: Option<String>,
    /// 目标笔记的真实标题；未解析（悬空链接）时为 null
    pub resolved_title: Option<String>,
    /// 是否已解析到具体笔记，即 `target_note_id.is_some()`
    pub resolved: bool,
}

/// 反链（对齐 Express `listBacklinks`）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteBacklink {
    pub source_note_id: String,
    pub source_title: String,
    pub source_updated_at: Option<String>,
}

/// 按笔记取标签。排序与 Express 一致（`t.name` NOCASE 升序）。
fn query_note_tags(
    connection: &Connection,
    note_path: &str,
) -> Result<Vec<NoteTag>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT t.id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_path = ?1 ORDER BY t.name COLLATE NOCASE ASC",
    )?;
    let rows = statement.query_map(params![note_path], |row| {
        Ok(NoteTag {
            id: row.get(0)?,
            name: row.get(1)?,
        })
    })?;
    rows.collect()
}

/// 出链。`LEFT JOIN` 保留悬空链接（`resolvedTitle` 为 null、`resolved` 为 false），
/// 与 Express `listOutgoing` 的 LEFT JOIN 语义一致。
fn query_outgoing_links(
    connection: &Connection,
    note_id: &str,
) -> Result<Vec<NoteOutgoingLink>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT l.target_title, l.target_note_id, n.title
           FROM links l LEFT JOIN notes n ON n.note_id = l.target_note_id
          WHERE l.source_note_id = ?1 ORDER BY l.target_title COLLATE NOCASE ASC",
    )?;
    let rows = statement.query_map(params![note_id], |row| {
        let target_title: String = row.get(0)?;
        let target_note_id: Option<String> = row.get(1)?;
        let resolved_title: Option<String> = row.get(2)?;
        Ok(NoteOutgoingLink {
            resolved: target_note_id.is_some(),
            target_title,
            target_note_id,
            resolved_title,
        })
    })?;
    rows.collect()
}

/// 反链。排序与 Express 一致（来源笔记 `updated_at` 降序）。
fn query_backlinks(
    connection: &Connection,
    note_id: &str,
) -> Result<Vec<NoteBacklink>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT l.source_note_id, n.title, n.updated_at
           FROM links l JOIN notes n ON n.note_id = l.source_note_id
          WHERE l.target_note_id = ?1 ORDER BY n.updated_at DESC",
    )?;
    let rows = statement.query_map(params![note_id], |row| {
        Ok(NoteBacklink {
            source_note_id: row.get(0)?,
            source_title: row.get(1)?,
            source_updated_at: row.get(2)?,
        })
    })?;
    rows.collect()
}

fn suggestion_terms(title: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for value in title.split(|ch: char| !ch.is_ascii_alphanumeric()) {
        if value.len() >= 2 {
            terms.push(value.to_lowercase());
        }
    }
    let cjk = title
        .chars()
        .filter(|ch| ('\u{3400}'..='\u{4dbf}').contains(ch) || ('\u{4e00}'..='\u{9fff}').contains(ch))
        .collect::<Vec<_>>();
    for pair in cjk.windows(2) {
        terms.push(pair.iter().collect());
    }
    let mut seen = HashSet::new();
    terms.retain(|term| seen.insert(term.clone()));
    terms
}

fn compact_digest_excerpt(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect()
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 健康扫描笔记（review scan 数据源；properties 为解析后的对象）。
pub struct HealthNote {
    pub id: String,
    pub title: String,
    pub content: String,
    pub file_path: String,
    pub folder_id: Option<String>,
    pub updated_at: Option<String>,
    pub created_at: Option<String>,
    pub word_count: i64,
    pub content_hash: Option<String>,
    pub properties: serde_json::Value,
}

/// 悬空链接明细行（review brokenLinks 数据源）。
pub struct DanglingLinkDetail {
    pub target_title: String,
    pub source_id: String,
    pub source_title: String,
    pub source_path: String,
}

/// 出链/入链计数对（note_id → 条数）。
pub type LinkCountPair = (HashMap<String, i64>, HashMap<String, i64>);

/// 轻量索引条目（对齐 Express listIndex，camelCase 序列化）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndexEntry {
    pub id: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub is_pinned: bool,
    pub file_path: String,
    pub word_count: u64,
    pub content_hash: Option<String>,
    #[serde(serialize_with = "serialize_properties_json")]
    pub properties_json: Option<String>,
    /// 解析后的属性对象（见 `properties_value`）
    pub properties: serde_json::Value,
    pub updated_at: String,
}

/// 图谱数据（对齐 Express buildGraph）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub dangling: Vec<DanglingLink>,
    pub stats: GraphStats,
}

/// 图谱节点（degree = 出链 + 入链，前端用于节点大小映射）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub is_pinned: bool,
    pub word_count: u64,
    pub degree: u64,
}

/// 图谱边（source → target，均为已解析的笔记 id）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

/// 悬空链接聚合（对齐 listDangling）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DanglingLink {
    pub target_title: String,
    pub reference_count: u64,
}

/// 图谱统计。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphStats {
    pub node_count: u64,
    pub edge_count: u64,
    pub isolated_count: u64,
}

/// 标签条目（对齐 Express tags 表投影，camelCase 序列化）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagEntry {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub note_count: u64,
}

/// 目录树节点（磁盘派生投影，camelCase 序列化）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: u64,
    pub note_count: u64,
    pub children: Vec<FolderNode>,
    /// 见 [`directory_timestamps`]：磁盘元数据派生，与 Express 的 DB 记录时间**不同源**。
    pub created_at: String,
    pub updated_at: String,
}

/// 附件仓库目录名（与 `workspace::WorkspaceService::ATTACHMENT_ROOT` 同值）。
const ATTACHMENT_STORE_DIR: &str = "attachments";

/// 「笔记目录」判定：排除内部目录（`INTERNAL_DIRS` 已在 `walk_directories` 里过滤）与附件仓库。
///
/// Express 的目录树与 `folderCount` 都由 `folders` 表驱动，而附件仓库 `<Vault>/attachments/`
/// 是附件上传直接建的目录、从不经 `foldersService.create`（`server/src/vault/sync.js` 的
/// `ensureFolderPath` 只为**笔记路径**建行），因此**从不出现在 Express 的目录树与目录计数里**。
/// Rust 是磁盘派生，必须显式排除才等价——否则桌面态会多出一个幽灵目录：fixture 实测
/// Express `folderCount = 2`，而 `walk_directories().len() = 3`（侧栏「目录 N」会差 1，
/// 且目录树首位会变成 `attachments`）。
///
/// 但**不能只按名字排除**：用户完全可以自建一个叫 `attachments` 的目录放笔记，
/// 那样 Express 也会建行并显示它。因此仅当它**下辖没有任何笔记**（`attachment_is_note_folder == false`）
/// 时才按内部仓库隐藏，避免静默吞掉用户的目录。
fn is_note_folder(directory: &str, attachment_is_note_folder: bool) -> bool {
    let first = directory.split('/').next().unwrap_or(directory);
    if !first.eq_ignore_ascii_case(ATTACHMENT_STORE_DIR) {
        return true;
    }
    attachment_is_note_folder
}

/// 指定目录（含子目录）下是否存在笔记。
///
/// 注意列名是 `path`（`db.rs` 的 `CREATE TABLE notes (path TEXT PRIMARY KEY, ...)`），
/// **不是** `file_path`——那是 `NoteIndexEntry` 的字段名。查询错误一律向上传播，
/// 不做「失败就当作有笔记」这类兜底：它会把拼错的列名伪装成正常行为（这里踩过一次，
/// 结果是目录树照旧多出附件仓库，而 parity 因为基线已对齐而保持绿）。
fn folder_has_notes(connection: &Connection, directory: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE path LIKE ?1",
            params![format!("{directory}/%")],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .map_err(|error| format!("无法统计目录下笔记：{error}"))
}

/// 把已建好的节点按 `children_of` 自根向下组装（顺序即调用方给定的兄弟顺序）。
fn assemble_folder_node(
    path: &str,
    nodes: &mut HashMap<String, FolderNode>,
    children_of: &HashMap<String, Vec<String>>,
) -> FolderNode {
    let mut node = nodes.remove(path).expect("目录节点存在");
    node.children = children_of
        .get(path)
        .map(|children| {
            children
                .iter()
                .map(|child| assemble_folder_node(child, nodes, children_of))
                .collect()
        })
        .unwrap_or_default();
    node
}

/// 目录时间戳（磁盘元数据 → ISO-8601 UTC）。
///
/// Express 的 `createdAt`/`updatedAt` 是「首次被应用发现」时写进 `folders` 表的记录时间
/// （`server/src/vault/sync.js:ensureFolderPath` 用 `nowIso()`）；Rust 没有 folders 表
/// （不变量 I1：磁盘是唯一真源），因此取目录自身在磁盘上的创建/修改时间。
/// **两者语义不同源，数值不保证与 Express 相等**，这里只保证类型与形状一致。
/// Linux 上目录常拿不到 birthtime（`created()` 报错）→ 回退到 mtime。
pub(crate) fn directory_timestamps(root: &Path, relative: &str) -> (String, String) {
    fn to_millis(time: std::io::Result<SystemTime>) -> Option<i64> {
        time.ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
    }
    let metadata = std::fs::metadata(root.join(relative));
    let (created, modified) = match metadata.as_ref() {
        Ok(meta) => (to_millis(meta.created()), to_millis(meta.modified())),
        Err(_) => (None, None),
    };
    let created = created.or(modified).unwrap_or_else(now_millis);
    let modified = modified.unwrap_or(created);
    (iso8601_utc(created), iso8601_utc(modified))
}

/// 知识库总览（对齐 Express meta.service overview）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaOverview {
    pub note_count: u64,
    pub folder_count: u64,
    pub tag_count: u64,
    pub link_count: u64,
    pub dangling_count: u64,
    pub total_words: u64,
    pub dangling_links: Vec<DanglingLink>,
}

/// 检索结果（对齐 Express search.service：strategy + mapRow items）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub strategy: &'static str,
    pub items: Vec<SearchItem>,
}

/// 多路召回的结构化结果。字段保持为 `SearchItem`，因此融合不会绕过
/// `folder_id`、`properties_json`、`updated_at` 等已经过滤和投影的元数据。
pub struct SearchRecall {
    pub fts: Vec<SearchItem>,
    pub like: Vec<SearchItem>,
    pub vector: Vec<SearchItem>,
    pub fts_attempted: bool,
}

/// 检索条目（对齐 Express mapRow，camelCase 序列化）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    pub id: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub file_path: String,
    pub is_pinned: bool,
    pub content_hash: Option<String>,
    #[serde(serialize_with = "serialize_properties_json")]
    pub properties_json: Option<String>,
    pub updated_at: Option<String>,
    pub excerpt: String,
}

fn write_row(
    connection: &Connection,
    path: &str,
    raw: &str,
    hash: &str,
    size: u64,
    modified_at: Option<i64>,
    indexed_at: &str,
) -> Result<(), String> {
    let title = title_from_markdown(raw, path);
    let frontmatter = parse_frontmatter(raw);
    // 正文口径（不含 frontmatter）：与 Express 的 note.content / computeWordCount 一致
    let body = strip_frontmatter(raw);
    let word_count = compute_word_count(body) as i64;
    let properties_json = frontmatter
        .as_ref()
        .filter(|meta| !meta.properties.is_empty())
        .map(|meta| serde_json::Value::Object(meta.properties.clone()).to_string());
    connection
        .execute(
            "INSERT INTO notes (path, title, content, content_hash, size, modified_at, indexed_at,
             note_id, is_pinned, word_count, created_at, properties_json, folder_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(path) DO UPDATE SET
               title = excluded.title,
               content = excluded.content,
               content_hash = excluded.content_hash,
               size = excluded.size,
               modified_at = excluded.modified_at,
               indexed_at = excluded.indexed_at,
               note_id = excluded.note_id,
               is_pinned = excluded.is_pinned,
               word_count = excluded.word_count,
               created_at = excluded.created_at,
               properties_json = excluded.properties_json,
               folder_id = excluded.folder_id",
            params![
                path,
                title,
                body,
                hash,
                size as i64,
                modified_at,
                indexed_at,
                frontmatter.as_ref().and_then(|meta| meta.id.clone()),
                frontmatter
                    .as_ref()
                    .map_or(0, |meta| i64::from(meta.pinned)),
                word_count,
                frontmatter
                    .as_ref()
                    .and_then(|meta| meta.created_at.clone()),
                properties_json,
                folder_id_for(path),
            ],
        )
        .map_err(|error| format!("无法写入索引：{error}"))?;
    // updated_at：frontmatter 业务时间戳优先，否则磁盘修改时间
    let business_updated_at = frontmatter
        .as_ref()
        .and_then(|meta| meta.updated_at.clone());
    connection
        .execute(
            "UPDATE notes SET updated_at = ?2 WHERE path = ?1",
            params![
                path,
                business_updated_at.or_else(|| modified_at.map(iso8601_utc))
            ],
        )
        .map_err(|error| format!("无法写入更新时间：{error}"))?;
    sync_links(connection, path, raw, indexed_at)?;
    sync_tags(connection, path, raw, indexed_at)?;
    embeddings::upsert_note_embedding(connection, path, hash, &title, body, indexed_at)
}

/// 同步一篇笔记的双向链接投影（对齐 rebuildForNote）：
/// 目标按标题 NOCASE 解析归属（同名取最近更新），未解析即悬空。
fn sync_links(
    connection: &Connection,
    path: &str,
    raw: &str,
    indexed_at: &str,
) -> Result<(), String> {
    let source_id: String = connection
        .query_row(
            "SELECT COALESCE(note_id, path) FROM notes WHERE path = ?1",
            params![path],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取链接源：{error}"))?;
    connection
        .execute(
            "DELETE FROM links WHERE source_note_id = ?1",
            params![source_id],
        )
        .map_err(|error| format!("无法清理链接：{error}"))?;
    for link in extract_wiki_links(raw) {
        let target_note_id: Option<String> = connection
            .query_row(
                "SELECT COALESCE(note_id, path) FROM notes
                 WHERE title = ?1 COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1",
                params![link.target],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("无法解析链接目标：{error}"))?;
        connection
            .execute(
                "INSERT INTO links (source_note_id, target_title, target_note_id, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![source_id, link.target, target_note_id, indexed_at],
            )
            .map_err(|error| format!("无法写入链接：{error}"))?;
    }
    Ok(())
}

/// 同步一篇笔记的标签派生（保存/扫描时调用；标签是正文的投影，可重建）。
fn sync_tags(
    connection: &Connection,
    path: &str,
    raw: &str,
    indexed_at: &str,
) -> Result<(), String> {
    let names = extract_note_tags(raw);
    connection
        .execute("DELETE FROM note_tags WHERE note_path = ?1", params![path])
        .map_err(|error| format!("无法清理标签关联：{error}"))?;
    for name in names {
        let tag_id = tag_id_for(&name);
        connection
            .execute(
                "INSERT INTO tags (id, name, created_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(name) DO NOTHING",
                params![tag_id, name, indexed_at],
            )
            .map_err(|error| format!("无法写入标签：{error}"))?;
        connection
            .execute(
                "INSERT OR IGNORE INTO note_tags (note_path, tag_id) VALUES (?1, ?2)",
                params![path, tag_id],
            )
            .map_err(|error| format!("无法关联标签：{error}"))?;
    }
    Ok(())
}

/// 标签 id：由名称确定性派生（UUID v4 形状），避免依赖随机 UUID 导致重建后 id 漂移。
fn tag_id_for(name: &str) -> String {
    stable_id(name)
}

/// 确定性投影 id（sha256 → UUID v4 形状）：标签/目录等磁盘派生实体共用。
fn stable_id(text: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
    format!(
        "{}{}-{}-4{}-8{}-{}",
        &digest[0..8],
        &digest[8..12],
        &digest[12..15],
        &digest[15..16],
        &digest[16..19],
        &digest[20..32]
    )
}

/// 笔记目录部分的确定性 id（顶层目录笔记返回 None，对齐 Express folderId=null）。
pub(crate) fn folder_id_for(path: &str) -> Option<String> {
    let directory = std::path::Path::new(path)
        .parent()?
        .to_string_lossy()
        .replace('\\', "/");
    if directory.is_empty() || directory == "." {
        return None;
    }
    Some(stable_id(&directory))
}

/// 目录路径 → 确定性 id（folder 写命令与树投影共用）。
pub fn stable_folder_id(directory: &str) -> String {
    stable_id(directory)
}

/// 由确定性 id 反查磁盘目录相对路径（folder 写命令定位用）。
pub fn directory_path_for_id(vault: &Vault, id: &str) -> Option<String> {
    vault
        .walk_directories()
        .ok()?
        .into_iter()
        .find(|directory| stable_id(directory) == id)
}

/// 已索引行的 `路径 -> (size, modified_at)`，用于增量比对。
fn load_metadata(connection: &Connection) -> Result<HashMap<String, (i64, Option<i64>)>, String> {
    let mut statement = connection
        .prepare("SELECT path, size, modified_at FROM notes")
        .map_err(|error| format!("无法读取索引元数据：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .map_err(|error| format!("无法读取索引元数据：{error}"))?;
    let mut metadata = HashMap::new();
    for row in rows {
        let (path, size, modified) = row.map_err(|error| format!("无法读取索引行：{error}"))?;
        metadata.insert(path, (size, modified));
    }
    Ok(metadata)
}

fn count_notes(connection: &Connection) -> Result<usize, String> {
    connection
        .query_row("SELECT count(*) FROM notes", [], |row| row.get::<_, i64>(0))
        .map(|count| count as usize)
        .map_err(|error| format!("无法统计索引：{error}"))
}

fn collect_search_items(
    connection: &Connection,
    matches: Vec<NoteMatch>,
    limit: usize,
    inbox_status: Option<&str>,
) -> Result<Vec<SearchItem>, String> {
    let mut items = Vec::with_capacity(matches.len().min(limit));
    for note_match in matches {
        let detail = connection
            .query_row(
                "SELECT COALESCE(note_id, path), folder_id, is_pinned, content_hash, properties_json, updated_at
                 FROM notes WHERE path = ?1",
                params![note_match.path],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)? != 0,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("无法读取检索行：{error}"))?;
        if let Some((id, folder_id, is_pinned, content_hash, properties_json, updated_at)) = detail
        {
            let properties = properties_value(properties_json.as_deref());
            let is_inbox_match = inbox_status.is_none_or(|status| {
                properties["type"] == serde_json::json!("inbox")
                    && (status == "all" || properties["status"] == serde_json::json!(status))
            });
            if !is_inbox_match {
                continue;
            }
            items.push(SearchItem {
                id,
                title: note_match.title,
                folder_id,
                file_path: note_match.path,
                is_pinned,
                content_hash,
                properties_json,
                updated_at,
                excerpt: note_match.excerpt,
            });
            if items.len() >= limit {
                break;
            }
        }
    }
    Ok(items)
}

fn full_text_search(
    connection: &Connection,
    query: &str,
    limit: i64,
    folder_id: Option<&str>,
    allowed_paths: Option<&[String]>,
) -> Result<Vec<NoteMatch>, String> {
    // FTS5 短语查询：整体加引号，内部引号按 FTS5 规则双写转义。
    let phrase = format!("\"{}\"", query.replace('"', "\"\""));
    let mut conditions = vec!["notes_fts MATCH ?1".to_owned()];
    let mut bind: Vec<Box<dyn ToSql>> = vec![Box::new(phrase)];
    let mut next_placeholder = 2;
    if let Some(folder_id) = folder_id {
        if folder_id == "__none__" {
            conditions.push("n.folder_id IS NULL".to_owned());
        } else {
            conditions.push(format!("n.folder_id = ?{next_placeholder}"));
            bind.push(Box::new(folder_id.to_owned()));
            next_placeholder += 1;
        }
    }
    if let Some(paths) = allowed_paths {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = (0..paths.len())
            .map(|index| format!("?{}", next_placeholder + index))
            .collect::<Vec<_>>()
            .join(", ");
        conditions.push(format!("n.path IN ({placeholders})"));
        bind.extend(
            paths
                .iter()
                .cloned()
                .map(|path| Box::new(path) as Box<dyn ToSql>),
        );
        next_placeholder += paths.len();
    }
    let limit_placeholder = format!("?{next_placeholder}");
    let sql = format!(
        "SELECT n.path, n.title, n.size, n.modified_at
           FROM notes_fts
           JOIN notes n ON n.path = notes_fts.path
          WHERE {}
          ORDER BY bm25(notes_fts), n.modified_at DESC
          LIMIT {limit_placeholder}",
        conditions.join(" AND ")
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("无法准备全文检索：{error}"))?;
    bind.push(Box::new(limit));
    let rows = statement
        .query_map(
            params_from_iter(bind.iter().map(|value| value.as_ref() as &dyn ToSql)),
            |row| {
                Ok(NoteMatch {
                    path: row.get(0)?,
                    title: row.get(1)?,
                    bytes: row.get::<_, i64>(2)? as u64,
                    modified_at: row.get(3)?,
                    excerpt: String::new(),
                })
            },
        )
        .map_err(|error| format!("全文检索失败：{error}"))?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(|error| format!("全文检索失败：{error}"))?);
    }
    fill_excerpts(connection, &mut notes, query)?;
    Ok(notes)
}

fn like_search(
    connection: &Connection,
    query: &str,
    limit: i64,
    folder_id: Option<&str>,
    allowed_paths: Option<&[String]>,
) -> Result<Vec<NoteMatch>, String> {
    let pattern = like_pattern(query);
    let mut conditions = vec![
        "(path LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\')"
            .to_owned(),
    ];
    let mut bind: Vec<Box<dyn ToSql>> = vec![Box::new(pattern)];
    let mut next_placeholder = 2;
    if let Some(folder_id) = folder_id {
        if folder_id == "__none__" {
            conditions.push("folder_id IS NULL".to_owned());
        } else {
            conditions.push(format!("folder_id = ?{next_placeholder}"));
            bind.push(Box::new(folder_id.to_owned()));
            next_placeholder += 1;
        }
    }
    if let Some(paths) = allowed_paths {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = (0..paths.len())
            .map(|index| format!("?{}", next_placeholder + index))
            .collect::<Vec<_>>()
            .join(", ");
        conditions.push(format!("path IN ({placeholders})"));
        bind.extend(
            paths
                .iter()
                .cloned()
                .map(|path| Box::new(path) as Box<dyn ToSql>),
        );
        next_placeholder += paths.len();
    }
    let limit_placeholder = format!("?{next_placeholder}");
    let sql = format!(
        "SELECT path, title, size, modified_at, content
           FROM notes
          WHERE {}
          ORDER BY modified_at DESC
          LIMIT {limit_placeholder}",
        conditions.join(" AND ")
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("无法准备兜底检索：{error}"))?;
    bind.push(Box::new(limit));
    let rows = statement
        .query_map(
            params_from_iter(bind.iter().map(|value| value.as_ref() as &dyn ToSql)),
            |row| {
                Ok(NoteMatch {
                    path: row.get(0)?,
                    title: row.get(1)?,
                    bytes: row.get::<_, i64>(2)? as u64,
                    modified_at: row.get(3)?,
                    excerpt: String::new(),
                })
            },
        )
        .map_err(|error| format!("兜底检索失败：{error}"))?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(|error| format!("兜底检索失败：{error}"))?);
    }
    fill_excerpts(connection, &mut notes, query)?;
    Ok(notes)
}

fn vector_search(
    connection: &Connection,
    query: &str,
    limit: i64,
    folder_id: Option<&str>,
    allowed_paths: Option<&[String]>,
) -> Result<Vec<NoteMatch>, String> {
    let query_vector = embeddings::embed_text(query);
    let mut conditions = Vec::new();
    let mut bind: Vec<Box<dyn ToSql>> = Vec::new();
    let mut next_placeholder = 1;
    if let Some(folder_id) = folder_id {
        if folder_id == "__none__" {
            conditions.push("n.folder_id IS NULL".to_owned());
        } else {
            conditions.push(format!("n.folder_id = ?{next_placeholder}"));
            bind.push(Box::new(folder_id.to_owned()));
            next_placeholder += 1;
        }
    }
    if let Some(paths) = allowed_paths {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = (0..paths.len())
            .map(|index| format!("?{}", next_placeholder + index))
            .collect::<Vec<_>>()
            .join(", ");
        conditions.push(format!("n.path IN ({placeholders})"));
        bind.extend(
            paths
                .iter()
                .cloned()
                .map(|path| Box::new(path) as Box<dyn ToSql>),
        );
    }
    let sql = format!(
        "SELECT n.path, n.title, n.size, n.modified_at, e.embedding
           FROM note_embeddings e
           JOIN notes n ON n.path = e.note_path
          WHERE {}",
        conditions.join(" AND ")
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("无法准备向量检索：{error}"))?;
    let rows = statement
        .query_map(
            params_from_iter(bind.iter().map(|value| value.as_ref() as &dyn ToSql)),
            |row| {
                Ok((
                    NoteMatch {
                        path: row.get(0)?,
                        title: row.get(1)?,
                        bytes: row.get::<_, i64>(2)? as u64,
                        modified_at: row.get(3)?,
                        excerpt: String::new(),
                    },
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(|error| format!("向量检索失败：{error}"))?;
    let mut scored = Vec::new();
    for row in rows {
        let (note, embedding) = row.map_err(|error| format!("向量检索失败：{error}"))?;
        let Ok(candidate) = serde_json::from_str::<Vec<f32>>(&embedding) else {
            log::warn!("跳过无法解析的向量：{}", note.path);
            continue;
        };
        let Some(score) = embeddings::cosine_similarity(&query_vector, &candidate) else {
            log::warn!("跳过维度不匹配的向量：{}", note.path);
            continue;
        };
        scored.push((score, note));
    }
    scored.sort_by(|left, right| right.0.total_cmp(&left.0));
    scored.truncate(limit as usize);
    let mut notes = scored.into_iter().map(|(_, note)| note).collect::<Vec<_>>();
    fill_excerpts(connection, &mut notes, query)?;
    Ok(notes)
}

/// 用原文补出命中上下文摘要（两条检索路径共用，行为一致）。
fn fill_excerpts(
    connection: &Connection,
    notes: &mut [NoteMatch],
    query: &str,
) -> Result<(), String> {
    if notes.is_empty() {
        return Ok(());
    }
    let mut statement = connection
        .prepare("SELECT content FROM notes WHERE path = ?1")
        .map_err(|error| format!("无法读取摘要原文：{error}"))?;
    for note in notes.iter_mut() {
        let content: String = statement
            .query_row(params![note.path], |row| row.get(0))
            .unwrap_or_default();
        note.excerpt = make_excerpt(&content, query);
    }
    Ok(())
}

/// LIKE 模式转义：`\`、`%`、`_` 三个元字符需要转义（配合 `ESCAPE '\'`）。
fn like_pattern(query: &str) -> String {
    let mut pattern = String::with_capacity(query.len() + 2);
    pattern.push('%');
    for character in query.chars() {
        if matches!(character, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

/// 生成命中上下文：大小写不敏感定位，前后各取半个窗口，折叠换行。
fn make_excerpt(content: &str, query: &str) -> String {
    let original: Vec<char> = content.chars().collect();
    let lowercase: Vec<char> = content.to_lowercase().chars().collect();
    let needle: Vec<char> = query.to_lowercase().chars().collect();

    // 极少数语言的大小写转换会改变字符数（如 ß→ss），此时索引会错位，退回取开头。
    // 查询词比正文还长时同样直接取开头，否则切片会越界（正文 1 字、查询 2 字即崩）。
    let position = if !needle.is_empty()
        && needle.len() <= lowercase.len()
        && lowercase.len() == original.len()
    {
        (0..=lowercase.len().saturating_sub(needle.len()))
            .find(|&start| lowercase[start..start + needle.len()] == needle[..])
    } else {
        None
    };

    let (start, end) = match position {
        Some(index) => (
            index.saturating_sub(EXCERPT_WINDOW / 2),
            (index + needle.len() + EXCERPT_WINDOW / 2).min(original.len()),
        ),
        None => (0, EXCERPT_WINDOW.min(original.len())),
    };

    let mut excerpt = String::new();
    if start > 0 {
        excerpt.push('…');
    }
    excerpt.extend(original[start..end].iter());
    if end < original.len() {
        excerpt.push('…');
    }
    excerpt.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::{Index, make_excerpt};
    use crate::vault::Vault;

    fn workspace() -> (tempfile::TempDir, Vault, Index) {
        let directory = tempfile::tempdir().unwrap();
        let vault = Vault::open(directory.path().into()).unwrap();
        let index = Index::open(vault.root()).unwrap();
        (directory, vault, index)
    }

    #[test]
    fn scan_indexes_new_files_then_skips_unchanged_and_tracks_edits() {
        let (_directory, vault, index) = workspace();
        vault.write("notes/a.md", "# 甲\n第一版", None).unwrap();
        vault.write("notes/b.md", "# 乙\n第二版", None).unwrap();

        let first = index.scan(&vault).unwrap();
        assert_eq!((first.added, first.unchanged, first.total), (2, 0, 2));

        // 再扫一次：没有任何文件变化，全部走 stat 快路径
        let second = index.scan(&vault).unwrap();
        assert_eq!((second.added, second.updated, second.unchanged), (0, 0, 2));

        // 改一篇：只应产生 1 条 updated。内容长度也一起变化，
        // 避免极端情况下「同一毫秒内同长度改写」而依赖 mtime 精度。
        let current = vault.read("notes/a.md").unwrap();
        vault
            .write("notes/a.md", "# 甲\n已经改过了", Some(&current.sha256))
            .unwrap();
        let third = index.scan(&vault).unwrap();
        assert_eq!((third.added, third.updated, third.unchanged), (0, 1, 1));
    }

    #[test]
    fn scan_drops_rows_whose_file_disappeared() {
        let (_directory, vault, index) = workspace();
        vault.write("gone.md", "# 将被删除", None).unwrap();
        vault.write("kept.md", "# 保留", None).unwrap();
        assert_eq!(index.scan(&vault).unwrap().total, 2);

        std::fs::remove_file(vault.root().join("gone.md")).unwrap();
        let summary = index.scan(&vault).unwrap();
        assert_eq!((summary.removed, summary.total), (1, 1));
        assert_eq!(index.list().unwrap().len(), 1);
    }

    #[test]
    fn list_notes_filters_sorts_and_paginates() {
        let (_directory, vault, index) = workspace();
        vault
            .write(
                "项目/捕获.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234571\ntitle: 捕获\ntype: inbox\nstatus: captured\n---\n\n捕获正文\n",
                None,
            )
            .unwrap();
        vault
            .write(
                "项目/处理.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234572\ntitle: 处理\ntype: inbox\nstatus: processed\n---\n\n处理正文\n",
                None,
            )
            .unwrap();
        vault
            .write(
                "根.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234573\ntitle: 根\n---\n\n根正文\n",
                None,
            )
            .unwrap();
        index.scan(&vault).unwrap();

        let folder_id = super::folder_id_for("项目/捕获.md").unwrap();
        let filtered = index
            .list_notes(Some(&folder_id), None, Some("captured"), "title", 20, 0)
            .unwrap();
        assert_eq!(filtered["total"], 1);
        assert_eq!(filtered["items"][0]["filePath"], "项目/捕获.md");
        assert_eq!(filtered["items"][0]["properties"]["status"], "captured");

        let page = index.list_notes(None, None, None, "title", 1, 1).unwrap();
        assert_eq!(page["limit"], 1);
        assert_eq!(page["offset"], 1);
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn search_matches_chinese_substring_through_trigram() {
        let (_directory, vault, index) = workspace();
        vault
            .write("dl.md", "# 笔记\n这是一篇关于深度学习的笔记", None)
            .unwrap();
        vault
            .write("other.md", "# 无关\n今天天气不错", None)
            .unwrap();
        index.scan(&vault).unwrap();

        // 4 个字符 >= trigram 的 3 字符窗口，走 FTS5 MATCH 路径；
        // 「深度学习」并不是一个独立分词，能命中即说明 trigram 在做子串匹配。
        let hits = index.search("深度学习", 20).unwrap();
        assert_eq!(hits.len(), 1, "trigram 应能命中中文子串");
        assert_eq!(hits[0].path, "dl.md");
        assert_eq!(hits[0].title, "笔记");
        assert!(
            hits[0].excerpt.contains("深度学习"),
            "excerpt={}",
            hits[0].excerpt
        );
    }

    #[test]
    fn search_falls_back_to_like_for_short_queries() {
        let (_directory, vault, index) = workspace();
        vault.write("a.md", "# 标题\n中文内容测试", None).unwrap();
        index.scan(&vault).unwrap();

        // 单字符短于 trigram 的 3 字符窗口，必须由 LIKE 兜底命中
        let hits = index.search("测", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.md");
    }

    #[test]
    fn search_matches_title_and_escapes_like_wildcards() {
        let (_directory, vault, index) = workspace();
        vault.write("t.md", "# 重要标题\n正文", None).unwrap();
        vault.write("p.md", "# 其他\n进度 100% 完成", None).unwrap();
        index.scan(&vault).unwrap();

        assert_eq!(index.search("重要", 20).unwrap().len(), 1);
        // `%` 是 LIKE 元字符，转义后只应命中真正包含百分号的那篇
        let percent = index.search("100%", 20).unwrap();
        assert_eq!(percent.len(), 1);
        assert_eq!(percent[0].path, "p.md");
    }

    #[test]
    fn search_query_applies_folder_and_inbox_filters_like_express() {
        let (_directory, vault, index) = workspace();
        vault
            .write(
                "项目/inbox.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234567\ntype: inbox\nstatus: captured\n---\n\n共同正文\n",
                None,
            )
            .unwrap();
        vault
            .write(
                "项目/plain.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234568\n---\n\n共同正文\n",
                None,
            )
            .unwrap();
        vault
            .write(
                "其他/inbox.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234569\ntype: inbox\nstatus: captured\n---\n\n共同正文\n",
                None,
            )
            .unwrap();
        index.scan(&vault).unwrap();

        let folder_id = super::folder_id_for("项目/inbox.md").unwrap();
        let result = index
            .search_query("共同", 20, Some(&folder_id), Some("captured"))
            .unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].file_path, "项目/inbox.md");
        let properties: serde_json::Value =
            serde_json::from_str(result.items[0].properties_json.as_deref().unwrap()).unwrap();
        assert_eq!(
            properties,
            serde_json::json!({"type": "inbox", "status": "captured"})
        );
        assert!(
            index
                .search_query("共同", 20, None, Some("invalid"))
                .is_err()
        );
    }

    #[test]
    fn upsert_keeps_index_synced_without_a_rescan() {
        let (_directory, vault, index) = workspace();
        vault.write("n.md", "# 初稿\n内容", None).unwrap();
        index.scan(&vault).unwrap();
        assert_eq!(index.search("内容", 20).unwrap().len(), 1);

        // 模拟命令层写入路径：落盘后直接 upsert，不触发全库扫描
        let current = vault.read("n.md").unwrap();
        let note = vault
            .write("n.md", "# 初稿\n改写后的内容", Some(&current.sha256))
            .unwrap();
        let meta = vault.stat("n.md").unwrap();
        index
            .upsert(
                &note.path,
                &note.raw,
                &note.sha256,
                meta.bytes,
                meta.modified_at,
            )
            .unwrap();

        assert_eq!(index.search("改写后", 20).unwrap().len(), 1);
        // 正文已整体替换：FTS 里不能再出现旧正文片段
        assert!(index.search("改写前不存在", 20).unwrap().is_empty());
    }

    #[test]
    fn note_detail_reads_found_row_columns_correctly() {
        // 回归：found-row 的列序映射（path/is_pinned 相邻易错位，
        // 批次2~5 无测试覆盖该路径，批次6 由附件引用收集暴露）。
        let (_directory, vault, index) = workspace();
        vault
            .write(
                "p.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234567\ntitle: 置顶笔记\npinned: true\n---\n\n正文\n",
                None,
            )
            .unwrap();
        index.scan(&vault).unwrap();

        let detail = index
            .find_note_detail(Some("019501a2-3b4c-4c5d-89ab-cdef01234567"), None)
            .unwrap()
            .expect("按 id 应找到");
        assert_eq!(detail.file_path.as_deref(), Some("p.md"));
        assert!(detail.is_pinned);
        assert!(detail.content.contains("正文"));

        let by_path = index
            .find_note_detail(None, Some("p.md"))
            .unwrap()
            .expect("按路径应找到");
        assert_eq!(by_path.id, "019501a2-3b4c-4c5d-89ab-cdef01234567");

        // 无 frontmatter id 的外部 Markdown 会把路径作为列表 id；详情查询
        // 必须接受这个 fallback id，保证点击列表后仍能打开正文。
        vault
            .write("external.md", "# 外部笔记\n正文", None)
            .unwrap();
        index.scan(&vault).unwrap();
        let external = index
            .find_note_detail(Some("external.md"), None)
            .unwrap()
            .expect("无 frontmatter id 时应按路径 fallback id 找到");
        assert_eq!(external.id, "external.md");
        assert_eq!(external.file_path.as_deref(), Some("external.md"));
    }

    #[test]
    fn ai_related_and_suggestions_use_projection_boundaries() {
        let (_directory, vault, index) = workspace();
        vault
            .write(
                "source.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234576\ntitle: Rust 架构\n---\n\nRust 架构设计与索引工程\n",
                None,
            )
            .unwrap();
        vault
            .write(
                "target.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234577\ntitle: Rust 工程\n---\n\nRust 工程实践 #工程\n",
                None,
            )
            .unwrap();
        vault
            .write(
                "linked.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234578\ntitle: Rust 链接\n---\n\n[[Rust 工程]]\n",
                None,
            )
            .unwrap();
        index.scan(&vault).unwrap();

        let source_id = "019501a2-3b4c-4c5d-89ab-cdef01234576";
        let related = index.related_notes(source_id, 6).unwrap();
        assert!(related.iter().all(|item| item.id != source_id));
        assert!(related.iter().any(|item| item.id == "019501a2-3b4c-4c5d-89ab-cdef01234577"));

        let suggestions = index.ai_suggestions(source_id, 6).unwrap();
        assert!(suggestions["links"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != source_id));
        assert!(suggestions["tags"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["name"] == "工程"));
    }

    #[test]
    fn excerpt_is_compact_and_marks_both_ends_when_truncated() {
        let content = format!("{}命中{}", "前".repeat(200), "后".repeat(200));
        let excerpt = make_excerpt(&content, "命中");
        assert!(excerpt.starts_with('…'));
        assert!(excerpt.ends_with('…'));
        assert!(excerpt.contains("命中"));
        assert!(excerpt.chars().count() < 200);
    }

    #[test]
    fn excerpt_falls_back_to_head_when_query_longer_than_content() {
        // 回归：正文比查询词还短时，切片不得越界（此前直接 panic 杀死进程）。
        assert!(!make_excerpt("短", "短文本搜索").is_empty());
        assert_eq!(make_excerpt("", "查询"), "");
        assert!(!make_excerpt("只有一句", "").is_empty());
    }

    #[test]
    fn ai_search_filters_allowed_paths_before_fts_and_like_recall() {
        let (_directory, vault, index) = workspace();
        vault
            .write("allowed.md", "# 允许\n\n权限测试内容", None)
            .unwrap();
        vault
            .write("hidden.md", "# 隐藏\n\n权限测试内容", None)
            .unwrap();
        index.scan(&vault).unwrap();

        let allowed = vec!["allowed.md".to_owned()];
        let result = index
            .search_query_with_allowed_paths("权限测试", 20, None, None, Some(&allowed))
            .unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].file_path, "allowed.md");

        let none: Vec<String> = Vec::new();
        let empty = index
            .search_query_with_allowed_paths("权限测试", 20, None, None, Some(&none))
            .unwrap();
        assert!(empty.items.is_empty());
    }

    #[test]
    fn vector_projection_refreshes_with_content_and_is_removed_with_note() {
        let (_directory, vault, index) = workspace();
        vault
            .write("allowed.md", "# 允许\n\n初始向量内容", None)
            .unwrap();
        vault
            .write("hidden.md", "# 隐藏\n\n不应被向量检索看到", None)
            .unwrap();
        index.scan(&vault).unwrap();

        let connection = index.connection.lock().unwrap();
        let before: String = connection
            .query_row(
                "SELECT content_hash FROM note_embeddings WHERE note_path = ?1",
                ["allowed.md"],
                |row| row.get(0),
            )
            .unwrap();
        let dimension: i64 = connection
            .query_row(
                "SELECT dimension FROM note_embeddings WHERE note_path = ?1",
                ["allowed.md"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(dimension, crate::ai::embeddings::VECTOR_DIMENSION as i64);
        drop(connection);

        let current = vault.read("allowed.md").unwrap();
        vault
            .write(
                "allowed.md",
                "# 允许\n\n更新后的向量检索内容",
                Some(&current.sha256),
            )
            .unwrap();
        index.scan(&vault).unwrap();
        let connection = index.connection.lock().unwrap();
        let after: String = connection
            .query_row(
                "SELECT content_hash FROM note_embeddings WHERE note_path = ?1",
                ["allowed.md"],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(before, after);
        drop(connection);

        std::fs::remove_file(vault.root().join("allowed.md")).unwrap();
        index.scan(&vault).unwrap();
        let connection = index.connection.lock().unwrap();
        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM note_embeddings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 1);
    }
}
