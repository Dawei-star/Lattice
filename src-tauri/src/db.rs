//! SQLite 连接与 Schema 迁移。
//!
//! 索引库固定放在 Vault 的 `.lattice/lattice.db`，与架构说明书一致：
//! **磁盘 Markdown 是唯一真源，SQLite 只是可随时删除重建的投影。**
//!
//! 使用 rusqlite 的 `bundled` 特性，SQLite 源码随二进制一起编译，
//! 因此不依赖系统 sqlite3.dll，并自带 FTS5 与 trigram 分词器。

use rusqlite::Connection;
use std::fs;
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
    backup_before_migration(path);
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

/// 迁移前备份（升级计划 P1-02）：库文件已存在且尚未升到最新版本时，
/// 把主库文件复制为 `<path>.bak-pre-migration`。
/// 备份失败只告警——投影库可由 Markdown 真源重建，不值得阻断启动；
/// WAL/SHM 不复制（SQLite 会用主库+日志自恢复，手工拼 WAL 反而危险）。
fn backup_before_migration(path: &Path) {
    let Ok(metadata) = fs::metadata(path) else { return };
    if metadata.len() == 0 {
        return;
    }
    let probe = match Connection::open(path) {
        Ok(connection) => connection,
        Err(error) => {
            log::warn!("迁移前备份探测失败（跳过备份）：{error}");
            return;
        }
    };
    let version: i64 = match probe.query_row("PRAGMA user_version", [], |row| row.get(0)) {
        Ok(version) => version,
        Err(error) => {
            log::warn!("迁移前备份读取版本失败（跳过备份）：{error}");
            return;
        }
    };
    drop(probe);
    if version >= SCHEMA_VERSION {
        return;
    }
    let backup = path.with_extension("db.bak-pre-migration");
    match fs::copy(path, &backup) {
        Ok(_) => log::info!("已备份 v{version} 索引库到 {}", backup.display()),
        Err(error) => log::warn!("迁移前备份失败（继续迁移）：{error}"),
    }
}

/// 按 `PRAGMA user_version` 逐步升级 Schema，可重复执行。
///
/// 迁移在事务内执行：任何一步失败都整体回滚、`user_version` 不提升，
/// 下次启动会重试而不是撞上半套残留 Schema（升级计划 P0-6 / P1-02）。
pub fn migrate(connection: &Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("无法读取索引库版本：{error}"))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    if version < 1 {
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| format!("无法开启迁移事务：{error}"))?;
        transaction
            .execute_batch(MIGRATION_001)
            .map_err(|error| {
                // 事务随 drop 回滚：半套 schema 不会落盘，便于失败诊断后重试。
                format!("无法创建索引表（已回滚，下次启动重试）：{error}")
            })?;
        transaction
            .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
            .map_err(|error| format!("无法写入索引库版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交迁移事务：{error}"))?;
        return Ok(());
    }
    connection
        .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
        .map_err(|error| format!("无法写入索引库版本：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{migrate, open};
    use rusqlite::Connection;
    use std::path::Path;

    /// 在指定库文件上打开连接并写入一行可检索数据（供恢复类测试复用）。
    fn open_and_seed(path: &Path) -> Connection {
        let connection = open(path).unwrap();
        connection
            .execute(
                "INSERT INTO notes (path, title, content, content_hash, size, modified_at, indexed_at)
                 VALUES ('seed.md', '种子', '恢复校验', 'hash', 12, 0, '2026-10-13T00:00:00.000Z')",
                [],
            )
            .unwrap();
        connection
    }

    fn count_notes(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT count(*) FROM notes", [], |row| row.get(0))
            .unwrap()
    }

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

    /// 迁移失败必须整体回滚：user_version 不提升、半套 schema 不残留
    /// （升级计划 P0-6：迁移失败回滚 + 失败诊断）。
    #[test]
    fn failed_migration_is_rolled_back_and_keeps_user_version() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join(".lattice/lattice.db");
        // 用裸连接预埋冲突（open() 会自动迁移，这里必须绕开）
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        let connection = Connection::open(&database).unwrap();
        connection
            .execute("CREATE TABLE notes (path TEXT PRIMARY KEY)", [])
            .unwrap();

        let error = migrate(&connection).expect_err("迁移应因冲突而失败");
        assert!(
            error.contains("已回滚"),
            "错误信息应说明已回滚以便诊断：{error}"
        );

        // user_version 不得被提升，否则下次启动会跳过迁移
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 0);

        // 事务回滚后不应残留 FTS 表/触发器等半套 schema
        let leftovers: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE name IN ('notes_fts', 'trg_notes_fts_insert', 'ix_notes_title')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leftovers, 0);
    }

    /// 异常退出（进程持有连接直接消失，WAL/SHM 残留）后，
    /// 重新打开必须由 SQLite 自恢复出完整已提交数据。
    /// 禁止任何"清理 WAL/SHM"式启动逻辑（升级计划 P0-6 / 风险 R11）。
    #[test]
    fn reopen_after_abnormal_exit_recovers_committed_data_from_wal() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join(".lattice/lattice.db");

        {
            let connection = open_and_seed(&database);
            // 确认 WAL 模式启用（恢复策略的前提）
            let mode: String = connection
                .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                .unwrap();
            assert_eq!(mode.to_lowercase(), "wal");
            // 模拟异常退出：连接既不 close 也不 checkpoint，进程直接消失。
            // mem::forget 让 Drop 不执行，WAL/SHM 原样留在磁盘上。
            std::mem::forget(connection);
        }

        // SQLite 的 WAL 伴随文件命名为 <库文件>-wal
        let mut wal_name = database.clone().into_os_string();
        wal_name.push("-wal");
        let wal_present = std::path::Path::new(&wal_name).exists();
        assert!(
            wal_present,
            "异常退出后 WAL 文件应残留（open 流程不得删除 WAL/SHM）"
        );

        let recovered = open(&database).unwrap();
        assert_eq!(count_notes(&recovered), 1);
    }

    /// 迁移前备份（升级计划 P1-02）：未迁移的非空库在 open 时
    /// 应产生 `.bak-pre-migration` 备份，随后迁移正常完成。
    #[test]
    fn open_backs_up_unmigrated_database_before_migration() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join(".lattice/lattice.db");
        // 预置一个非空、未迁移（user_version=0）的旧库
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        {
            let legacy = Connection::open(&database).unwrap();
            legacy.execute("CREATE TABLE legacy_data (value TEXT)", []).unwrap();
            legacy
                .execute("INSERT INTO legacy_data (value) VALUES ('旧数据')", [])
                .unwrap();
        }

        let connection = open(&database).unwrap();

        let backup = database.with_extension("db.bak-pre-migration");
        assert!(backup.exists(), "迁移前应生成备份文件");
        let restored = Connection::open(&backup).unwrap();
        let legacy_rows: i64 = restored
            .query_row("SELECT count(*) FROM legacy_data", [], |row| row.get(0))
            .unwrap();
        assert_eq!(legacy_rows, 1, "备份应保留旧库内容");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, super::SCHEMA_VERSION, "迁移照常完成");
    }

    /// 重复启动：同一库反复 open（每次启动都会重跑 PRAGMA 与迁移检查），
    /// 数据与写入能力不受影响（升级计划 P0-6：重复启动测试）。
    #[test]
    fn repeated_open_cycles_keep_data_writable() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join(".lattice/lattice.db");

        open_and_seed(&database);
        for cycle in 1..=3 {
            let connection = open(&database).unwrap();
            // 种子 1 行 + 前 cycle-1 轮各插入 1 行
            assert_eq!(
                count_notes(&connection),
                cycle,
                "第 {cycle} 次重启后数据应完整"
            );
            connection
                .execute(
                    "INSERT INTO notes (path, title, content, content_hash, size, modified_at, indexed_at)
                     VALUES (?1, 'n', 'c', 'h', 1, 0, '2026-10-13T00:00:00.000Z')",
                    [format!("cycle-{cycle}.md")],
                )
                .unwrap();
            assert_eq!(count_notes(&connection), 1 + cycle);
        }
    }
}
