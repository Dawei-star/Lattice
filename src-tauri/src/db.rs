//! SQLite 连接与 Schema 迁移。
//!
//! 索引库固定放在 Vault 的 `.lattice/lattice.db`，与架构说明书一致：
//! **磁盘 Markdown 是唯一真源，SQLite 只是可随时删除重建的投影。**
//!
//! 使用 rusqlite 的 `bundled` 特性，SQLite 源码随二进制一起编译，
//! 因此不依赖系统 sqlite3.dll，并自带 FTS5 与 trigram 分词器。

use rusqlite::Connection;
use std::path::Path;

/// 当前 Schema 版本，存于 `PRAGMA user_version`，用于增量迁移。
pub const SCHEMA_VERSION: i64 = 1;

/// 001：索引投影初版。
///
/// 与 `server/src/migrations/001_init.sql` 保持同一套语义（FTS5 trigram +
/// 触发器强一致），差别是投影主键用 Vault 内相对路径而不是 uuid ——
/// 原生版是「文件系统优先」，路径就是笔记的天然身份。
const MIGRATION_001: &str = r#"
-- 笔记投影：元数据 + 正文副本。正文副本只服务于全文检索与摘要生成，
-- 磁盘上的 Markdown 仍是唯一真源。
CREATE TABLE notes (
  path         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  size         INTEGER NOT NULL,
  modified_at  INTEGER,
  indexed_at   TEXT NOT NULL
);

-- 检索结果按修改时间倒序；标题索引服务于双链按标题解析（下一阶段）。
CREATE INDEX ix_notes_title ON notes (title COLLATE NOCASE);
CREATE INDEX ix_notes_modified ON notes (modified_at DESC);

-- trigram 分词器按 3 字符滑窗建索引，因此中文可以做子串匹配；
-- SQLite 默认的 unicode61 会把一整串汉字当成单个词，中文搜索基本失效。
-- path 声明为 UNINDEXED，仅作为回表关联键。
CREATE VIRTUAL TABLE notes_fts USING fts5 (
  path UNINDEXED,
  title,
  content,
  tokenize = 'trigram'
);

-- 触发器保证 FTS 与主表强一致，业务层无需手工维护两处（沿用原项目做法）。
CREATE TRIGGER trg_notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (path, title, content) VALUES (new.path, new.title, new.content);
END;

CREATE TRIGGER trg_notes_fts_delete AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE path = old.path;
END;

CREATE TRIGGER trg_notes_fts_update AFTER UPDATE OF title, content ON notes BEGIN
  DELETE FROM notes_fts WHERE path = old.path;
  INSERT INTO notes_fts (path, title, content) VALUES (new.path, new.title, new.content);
END;
"#;

/// 打开索引库并把 Schema 迁移到最新版本。
pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建索引目录：{error}"))?;
    }
    let connection =
        Connection::open(path).map_err(|error| format!("无法打开索引库：{error}"))?;
    connection
        .execute_batch(
            // WAL：读写不互相阻塞；NORMAL 在 WAL 下兼顾安全与性能；
            // busy_timeout 让写入被占用时等待而不是直接抛 SQLITE_BUSY。
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA temp_store = MEMORY;",
        )
        .map_err(|error| format!("无法设置索引库 PRAGMA：{error}"))?;
    migrate(&connection)?;
    Ok(connection)
}

/// 按 `PRAGMA user_version` 逐步升级 Schema，可重复执行。
pub fn migrate(connection: &Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("无法读取索引库版本：{error}"))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    if version < 1 {
        connection
            .execute_batch(MIGRATION_001)
            .map_err(|error| format!("无法创建索引表：{error}"))?;
    }
    connection
        .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
        .map_err(|error| format!("无法写入索引库版本：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{migrate, open};

    #[test]
    fn migration_is_idempotent_and_enables_trigram_fts() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join(".lattice/lattice.db");
        let connection = open(&database).unwrap();
        // 重复迁移不应报错（模拟每次启动都跑一遍）
        migrate(&connection).unwrap();

        connection
            .execute(
                "INSERT INTO notes (path, title, content, content_hash, size, modified_at, indexed_at)
                 VALUES ('a.md', '标题', '深度学习笔记', 'hash', 6, 0, '2026-10-13T00:00:00.000Z')",
                [],
            )
            .unwrap();
        // 触发器应把内容同步进 FTS，且 trigram 能命中中文子串。
        // trigram 分词器要求查询串至少 3 个字符，2 字符短查询由
        // index 层的 LIKE 回退负责（见 index::tests）。
        let hits: i64 = connection
            .query_row(
                "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH ?1",
                ["\"学习笔\""],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }
}
