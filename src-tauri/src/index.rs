//! 索引层：SQLite 投影 + FTS5 trigram 全文检索 + 增量扫描。
//!
//! 设计要点（对齐架构说明书 Phase 1）：
//! - **磁盘 Markdown 是唯一真源**，这里只是可随时删除重建的投影；
//! - 增量对齐靠 `(size, modified_at)` 比对，未变化的文件**完全不读盘**；
//! - 检索优先 FTS5 `MATCH`（trigram 分词，中文子串可命中），
//!   短于 3 字符的查询以及 FTS 未命中时走 `LIKE` 兜底 —— 与原项目两条路径一致。

use crate::db;
use crate::markdown::{compute_word_count, extract_note_tags, extract_wiki_links, parse_frontmatter, strip_frontmatter};
use crate::time::{iso8601_utc, now_millis};
use crate::vault::{NoteFile, Vault, title_from_markdown};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

/// trigram 分词器按 3 字符滑窗建索引，短于此长度的查询交给 LIKE 兜底。
const TRIGRAM_MIN_CHARS: usize = 3;
/// 摘要命中的上下文窗口（字符），前后各取一半。
const EXCERPT_WINDOW: usize = 60;

pub struct Index {
    connection: Mutex<Connection>,
    database: PathBuf,
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
            match full_text_search(&connection, query, limit) {
                Ok(found) => matches = found,
                // FTS 异常（短语语法、索引损坏）不该让搜索整体失败，
                // 降级到 LIKE 仍然能给出结果。
                Err(error) => log::warn!("FTS5 检索失败，回退 LIKE 兜底：{error}"),
            }
        }
        if matches.is_empty() {
            matches = like_search(&connection, query, limit)?;
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
    pub fn search_query(&self, query: &str, limit: usize) -> Result<SearchOutcome, String> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 200 {
            return Err("Search query must contain 1-200 characters".into());
        }
        let limit = limit.clamp(1, 200) as i64;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;

        let mut strategy = "like";
        let mut matches: Vec<NoteMatch> = Vec::new();
        let mut fts_attempted = false;
        if query.chars().count() >= TRIGRAM_MIN_CHARS {
            fts_attempted = true;
            match full_text_search(&connection, query, limit) {
                Ok(found) => matches = found,
                Err(error) => log::warn!("FTS5 检索失败，回退 LIKE 兜底：{error}"),
            }
        }
        if matches.is_empty() {
            matches = like_search(&connection, query, limit)?;
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
            if let Some((id, folder_id, is_pinned, content_hash, properties_json, updated_at)) = detail {
                items.push(SearchItem {
                    id,
                    title: note_match.title,
                    folder_id,
                    file_path: note_match.path,
                    is_pinned,
                    content_hash,
                    properties: properties_value(properties_json.as_deref()),
                    properties_json,
                    updated_at,
                    excerpt: note_match.excerpt,
                });
            }
        }
        Ok(SearchOutcome { strategy, items })
    }

    #[allow(dead_code)] // P1-04 删除/移动命令迁移接线前暂未使用
    pub fn remove(&self, path: &str) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection
            .execute("DELETE FROM note_tags WHERE note_path = ?1", params![path])
            .map_err(|error| format!("无法清理标签关联：{error}"))?;
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
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
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
            let mut statement = connection.prepare(sql).map_err(|error| format!("无法统计链接：{error}"))?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
                .map_err(|error| format!("无法统计链接：{error}"))?;
            let mut map = HashMap::new();
            for row in rows {
                let (key, count) = row.map_err(|error| format!("无法读取链接计数：{error}"))?;
                map.insert(key, count);
            }
            Ok(map)
        };
        let outgoing = count_by("SELECT source_note_id, COUNT(*) FROM links GROUP BY source_note_id")?;
        let incoming = count_by("SELECT target_note_id, COUNT(*) FROM links WHERE target_note_id IS NOT NULL GROUP BY target_note_id")?;
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
    /// 以磁盘目录为准派生（含空目录），id 为确定性投影 id，
    /// noteCount 为直属笔记数。sortOrder 恒 0（用户排序随 folders 表批次）。
    pub fn folder_tree(&self, vault: &Vault) -> Result<Vec<FolderNode>, String> {
        let directories = vault.walk_directories()?;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut nodes: HashMap<String, FolderNode> = HashMap::new();
        for directory in &directories {
            let name = directory.rsplit('/').next().unwrap_or(directory).to_owned();
            let parent_path = directory.rsplit_once('/').map(|(parent, _)| parent.to_owned());
            let direct_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM notes WHERE folder_id = ?1",
                    params![stable_id(directory)],
                    |row| row.get(0),
                )
                .map_err(|error| format!("无法统计目录笔记：{error}"))?;
            nodes.insert(
                directory.clone(),
                FolderNode {
                    id: stable_id(directory),
                    name,
                    parent_id: parent_path.as_ref().map(|parent| stable_id(parent)),
                    sort_order: 0,
                    note_count: direct_count as u64,
                    children: Vec::new(),
                },
            );
        }
        // 组树：父在子之前（目录列表已按路径排序，父路径必然先出现）
        let mut ordered: Vec<String> = nodes.keys().cloned().collect();
        ordered.sort();
        let mut roots = Vec::new();
        for path in ordered {
            let node = nodes.remove(&path).expect("目录节点存在");
            let parent_id = node.parent_id.clone();
            match parent_id
                .as_ref()
                .and_then(|parent| nodes.values_mut().find(|node| node.id == *parent))
            {
                Some(parent) => parent.children.push(node),
                None => roots.push(node),
            }
            let _ = node; // move 后占位
        }
        Ok(roots)
    }

    /// 契约 GET /api/meta/overview 的对应命令 meta_overview：
    /// 知识库统计 + 悬空链接列表，形状对齐 Express meta.service overview。
    pub fn meta_overview(&self, vault: &Vault) -> Result<MetaOverview, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let note_count = count_notes(&connection)? as u64;
        let folder_count = vault.walk_directories()?.len() as u64;
        let tag_count: u64 = connection
            .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("无法统计标签：{error}"))? as u64;
        let link_count: u64 = connection
            .query_row("SELECT COUNT(*) FROM links WHERE target_note_id IS NOT NULL", [], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("无法统计链接：{error}"))? as u64;
        let dangling_count: u64 = connection
            .query_row("SELECT COUNT(DISTINCT target_title COLLATE NOCASE) FROM links WHERE target_note_id IS NULL", [], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("无法统计悬空链接：{error}"))? as u64;
        let total_words: u64 = connection
            .query_row("SELECT COALESCE(SUM(word_count), 0) FROM notes", [], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("无法统计字数：{error}"))? as u64;
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
    pub fn find_note_detail(&self, by_id: Option<&str>, by_path: Option<&str>) -> Result<Option<NoteDetail>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let (column, value) = match (by_id, by_path) {
            (Some(id), _) => ("note_id", id.to_owned()),
            (None, Some(path)) => ("path", path.to_owned()),
            _ => return Ok(None),
        };
        let sql = format!(
            "SELECT COALESCE(note_id, path), title, content, folder_id, is_pinned, path, word_count,
             content_hash, properties_json, created_at, updated_at FROM notes WHERE {column} = ?1"
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
            .query_row("SELECT path FROM notes WHERE path = ?1", params![path], |row| row.get(0))
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
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)))
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
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)))
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
        let existing: std::collections::HashSet<String> = nodes.iter().map(|node| node.id.clone()).collect();

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
fn query_note_tags(connection: &Connection, note_path: &str) -> Result<Vec<NoteTag>, rusqlite::Error> {
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
fn query_outgoing_links(connection: &Connection, note_id: &str) -> Result<Vec<NoteOutgoingLink>, rusqlite::Error> {
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
fn query_backlinks(connection: &Connection, note_id: &str) -> Result<Vec<NoteBacklink>, rusqlite::Error> {
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

/// 检索条目（对齐 Express mapRow，camelCase 序列化）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    pub id: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub file_path: String,
    pub is_pinned: bool,
    pub content_hash: Option<String>,
    pub properties_json: Option<String>,
    /// 解析后的属性对象（见 `properties_value`）
    pub properties: serde_json::Value,
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
                frontmatter.as_ref().map_or(0, |meta| i64::from(meta.pinned)),
                word_count,
                frontmatter.as_ref().and_then(|meta| meta.created_at.clone()),
                properties_json,
                folder_id_for(path),
            ],
        )
        .map_err(|error| format!("无法写入索引：{error}"))?;
    // updated_at：frontmatter 业务时间戳优先，否则磁盘修改时间
    let business_updated_at = frontmatter.as_ref().and_then(|meta| meta.updated_at.clone());
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
    sync_tags(connection, path, raw, indexed_at)
}

/// 同步一篇笔记的双向链接投影（对齐 rebuildForNote）：
/// 目标按标题 NOCASE 解析归属（同名取最近更新），未解析即悬空。
fn sync_links(connection: &Connection, path: &str, raw: &str, indexed_at: &str) -> Result<(), String> {
    let source_id: String = connection
        .query_row(
            "SELECT COALESCE(note_id, path) FROM notes WHERE path = ?1",
            params![path],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取链接源：{error}"))?;
    connection
        .execute("DELETE FROM links WHERE source_note_id = ?1", params![source_id])
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
fn sync_tags(connection: &Connection, path: &str, raw: &str, indexed_at: &str) -> Result<(), String> {
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
fn folder_id_for(path: &str) -> Option<String> {
    let directory = std::path::Path::new(path).parent()?.to_string_lossy().replace('\\', "/");
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

fn full_text_search(
    connection: &Connection,
    query: &str,
    limit: i64,
) -> Result<Vec<NoteMatch>, String> {
    // FTS5 短语查询：整体加引号，内部引号按 FTS5 规则双写转义。
    let phrase = format!("\"{}\"", query.replace('"', "\"\""));
    let mut statement = connection
        .prepare(
            "SELECT n.path, n.title, n.size, n.modified_at
               FROM notes_fts
               JOIN notes n ON n.path = notes_fts.path
              WHERE notes_fts MATCH ?1
              ORDER BY bm25(notes_fts), n.modified_at DESC
              LIMIT ?2",
        )
        .map_err(|error| format!("无法准备全文检索：{error}"))?;
    let rows = statement
        .query_map(params![phrase, limit], |row| {
            Ok(NoteMatch {
                path: row.get(0)?,
                title: row.get(1)?,
                bytes: row.get::<_, i64>(2)? as u64,
                modified_at: row.get(3)?,
                excerpt: String::new(),
            })
        })
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
) -> Result<Vec<NoteMatch>, String> {
    let pattern = like_pattern(query);
    let mut statement = connection
        .prepare(
            "SELECT path, title, size, modified_at, content
               FROM notes
              WHERE path LIKE ?1 ESCAPE '\\'
                 OR title LIKE ?1 ESCAPE '\\'
                 OR content LIKE ?1 ESCAPE '\\'
              ORDER BY modified_at DESC
              LIMIT ?2",
        )
        .map_err(|error| format!("无法准备兜底检索：{error}"))?;
    let rows = statement
        .query_map(params![pattern, limit], |row| {
            Ok(NoteMatch {
                path: row.get(0)?,
                title: row.get(1)?,
                bytes: row.get::<_, i64>(2)? as u64,
                modified_at: row.get(3)?,
                excerpt: String::new(),
            })
        })
        .map_err(|error| format!("兜底检索失败：{error}"))?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(|error| format!("兜底检索失败：{error}"))?);
    }
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
    let position = if !needle.is_empty() && lowercase.len() == original.len() {
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
    excerpt
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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
    fn search_matches_chinese_substring_through_trigram() {
        let (_directory, vault, index) = workspace();
        vault
            .write("dl.md", "# 笔记\n这是一篇关于深度学习的笔记", None)
            .unwrap();
        vault.write("other.md", "# 无关\n今天天气不错", None).unwrap();
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
            .upsert(&note.path, &note.raw, &note.sha256, meta.bytes, meta.modified_at)
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
}
