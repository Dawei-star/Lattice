//! 索引层：SQLite 投影 + FTS5 trigram 全文检索 + 增量扫描。
//!
//! 设计要点（对齐架构说明书 Phase 1）：
//! - **磁盘 Markdown 是唯一真源**，这里只是可随时删除重建的投影；
//! - 增量对齐靠 `(size, modified_at)` 比对，未变化的文件**完全不读盘**；
//! - 检索优先 FTS5 `MATCH`（trigram 分词，中文子串可命中），
//!   短于 3 字符的查询以及 FTS 未命中时走 `LIKE` 兜底 —— 与原项目两条路径一致。

use crate::db;
use crate::markdown::{compute_word_count, extract_note_tags, parse_frontmatter, strip_frontmatter};
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
                "SELECT COALESCE(note_id, path), title, is_pinned, path, word_count,
                 content_hash, properties_json, COALESCE(created_at, indexed_at)
                 FROM notes ORDER BY modified_at DESC",
            )
            .map_err(|error| format!("无法查询笔记索引：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(NoteIndexEntry {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    folder_id: None,
                    is_pinned: row.get::<_, i64>(2)? != 0,
                    file_path: row.get(3)?,
                    word_count: row.get::<_, i64>(4)? as u64,
                    content_hash: row.get(5)?,
                    properties_json: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(|error| format!("无法查询笔记索引：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取笔记索引行：{error}"))
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
            "SELECT COALESCE(note_id, path), title, content, is_pinned, path, word_count,
             content_hash, properties_json, created_at, updated_at FROM notes WHERE {column} = ?1"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("无法查询笔记详情：{error}"))?;
        let detail = statement
            .query_row(params![value], |row| {
                Ok(NoteDetail {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    folder_id: None,
                    file_path: Some(row.get(3)?),
                    is_pinned: row.get::<_, i64>(4)? != 0,
                    word_count: row.get::<_, i64>(5)? as u64,
                    content_hash: row.get(6)?,
                    properties_json: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .optional()
            .map_err(|error| format!("无法读取笔记详情：{error}"))?;
        Ok(detail)
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
}

/// 笔记详情（对齐 Express mapNote，camelCase 序列化）。
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
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

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
    pub updated_at: String,
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
             note_id, is_pinned, word_count, created_at, properties_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
               properties_json = excluded.properties_json",
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
    sync_tags(connection, path, raw, indexed_at)
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
    let digest = format!("{:x}", Sha256::digest(name.as_bytes()));
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
    fn excerpt_is_compact_and_marks_both_ends_when_truncated() {
        let content = format!("{}命中{}", "前".repeat(200), "后".repeat(200));
        let excerpt = make_excerpt(&content, "命中");
        assert!(excerpt.starts_with('…'));
        assert!(excerpt.ends_with('…'));
        assert!(excerpt.contains("命中"));
        assert!(excerpt.chars().count() < 200);
    }
}
