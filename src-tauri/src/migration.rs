//! Legacy SQLite -> Markdown migration.
//!
//! The input database is an explicitly selected pre-v0.2.0 database. The
//! current projection database is rejected as input by design.

use crate::markdown::{
    MarkdownDocument, is_valid_note_id, sanitize_file_part, serialize_markdown_document,
};
use crate::workspace::{ServiceError, WorkspaceService};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Map;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationSummary {
    pub migrated: Vec<MigrationItem>,
    pub skipped: Vec<MigrationItem>,
    pub conflicts: Vec<MigrationItem>,
    pub total: usize,
    pub sqlite_path: String,
    pub backup_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationItem {
    pub id: String,
    pub file_path: String,
    pub reason: Option<String>,
}

#[derive(Debug)]
struct LegacyNote {
    id: String,
    title: String,
    content: String,
    folder_id: Option<String>,
    file_path: Option<String>,
    is_pinned: bool,
    created_at: String,
    updated_at: String,
    properties: Map<String, serde_json::Value>,
}

#[derive(Debug)]
struct PlannedNote {
    note: LegacyNote,
    path: String,
}

pub fn migrate_sqlite(
    workspace: &WorkspaceService,
    sqlite_path: &str,
    confirmed: bool,
    second_confirmed: bool,
) -> Result<MigrationSummary, ServiceError> {
    if !confirmed {
        return Err(ServiceError::new(
            "CONFIRMATION_REQUIRED",
            "SQLite 迁移需要 confirmed=true",
        ));
    }
    if !second_confirmed {
        return Err(ServiceError::new(
            "CONFIRMATION_REQUIRED",
            "SQLite 迁移需要完成二次确认",
        ));
    }

    let source = validate_source_path(workspace, sqlite_path)?;
    let backup = source.with_extension("db.bak-before-vault-migration");
    if !backup.exists() {
        fs::copy(&source, &backup).map_err(|error| {
            ServiceError::new("IO_ERROR", format!("无法创建迁移前备份：{error}"))
        })?;
    }

    let connection = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| {
            ServiceError::new(
                "MIGRATION_INPUT_ERROR",
                format!("无法打开旧 SQLite：{error}"),
            )
        })?;
    validate_schema(&connection)?;
    let folders = read_folders(&connection)?;
    let notes = read_notes(&connection)?;

    workspace
        .index()
        .scan(workspace.vault())
        .map_err(|error| ServiceError::new("SCAN_ERROR", error))?;
    let mut occupied = workspace
        .vault()
        .scan_files()
        .map_err(|error| ServiceError::new("IO_ERROR", error))?
        .into_iter()
        .map(|entry| entry.path)
        .collect::<HashSet<_>>();
    let total = notes.len();
    let mut plans = Vec::new();
    let mut skipped = Vec::new();
    let conflicts = Vec::new();
    let mut seen_ids = HashSet::new();

    for note in notes {
        if !is_valid_note_id(&note.id) || !seen_ids.insert(note.id.clone()) {
            return Err(ServiceError::new(
                "MIGRATION_INPUT_ERROR",
                "旧 SQLite 含有非法或重复的笔记 id",
            ));
        }
        if let Some(existing) = workspace
            .index()
            .find_note_detail(Some(&note.id), None)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
        {
            skipped.push(MigrationItem {
                id: note.id,
                file_path: existing.file_path.unwrap_or_default(),
                reason: Some("already-migrated".into()),
            });
            continue;
        }
        let base = note.file_path.clone().unwrap_or_else(|| {
            let folder = folder_path(note.folder_id.as_deref(), &folders);
            let stem = sanitize_file_part(&note.title, "未命名笔记");
            if folder.is_empty() {
                format!("{stem}.md")
            } else {
                format!("{folder}/{stem}.md")
            }
        });
        let base = base.replace('\\', "/");
        validate_relative_note_path(&base)?;
        let mut path = base.clone();
        let mut suffix = 2;
        while occupied.contains(&path) {
            let stem = path_without_extension(&base);
            path = format!("{stem} ({suffix}).md");
            suffix += 1;
        }
        occupied.insert(path.clone());
        plans.push(PlannedNote { note, path });
    }

    let mut created = Vec::<PathBuf>::new();
    let mut migrated = Vec::new();
    for plan in plans {
        let raw = serialize_markdown_document(&MarkdownDocument {
            id: &plan.note.id,
            title: &plan.note.title,
            content: &plan.note.content,
            is_pinned: plan.note.is_pinned,
            created_at: &plan.note.created_at,
            updated_at: &plan.note.updated_at,
            properties: &plan.note.properties,
        });
        if let Err(error) = workspace.write(&plan.path, &raw, None, "sqlite-migration") {
            for path in created {
                let _ = fs::remove_file(path);
            }
            let _ = workspace.index().scan(workspace.vault());
            return Err(ServiceError::new(
                "MIGRATION_FAILED",
                format!("迁移失败，已回滚本批新增文件：{}", error.message),
            ));
        }
        created.push(workspace.vault().root().join(&plan.path));
        migrated.push(MigrationItem {
            id: plan.note.id,
            file_path: plan.path,
            reason: None,
        });
    }
    workspace
        .index()
        .scan(workspace.vault())
        .map_err(|error| ServiceError::new("SCAN_ERROR", error))?;
    Ok(MigrationSummary {
        total,
        migrated,
        skipped,
        conflicts,
        sqlite_path: source.display().to_string(),
        backup_path: backup.display().to_string(),
    })
}

fn validate_source_path(workspace: &WorkspaceService, raw: &str) -> Result<PathBuf, ServiceError> {
    let source = PathBuf::from(raw.trim());
    if !source.is_absolute() {
        return Err(ServiceError::new("VALIDATION", "sqlitePath 必须是绝对路径"));
    }
    let source = source
        .canonicalize()
        .map_err(|error| ServiceError::new("NOT_FOUND", format!("旧 SQLite 不存在：{error}")))?;
    if !source.is_file() {
        return Err(ServiceError::new(
            "VALIDATION",
            "sqlitePath 必须指向 SQLite 文件",
        ));
    }
    let current = workspace.vault().root().join(".lattice").join("lattice.db");
    if current.exists() && source == current.canonicalize().unwrap_or(current) {
        return Err(ServiceError::new(
            "VALIDATION",
            "不能把当前 Vault 的 .lattice/lattice.db 作为旧 SQLite 迁移输入",
        ));
    }
    Ok(source)
}

fn validate_schema(connection: &Connection) -> Result<(), ServiceError> {
    for table in ["folders", "notes"] {
        let exists: Option<String> = connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| {
                ServiceError::new(
                    "MIGRATION_INPUT_ERROR",
                    format!("无法检查旧 schema：{error}"),
                )
            })?;
        if exists.is_none() {
            return Err(ServiceError::new(
                "MIGRATION_INPUT_ERROR",
                format!("旧 SQLite 缺少 {table} 表"),
            ));
        }
    }
    let required = [
        "id",
        "title",
        "content",
        "folder_id",
        "is_pinned",
        "created_at",
        "updated_at",
    ];
    let mut statement = connection
        .prepare("PRAGMA table_info(notes)")
        .map_err(|error| ServiceError::new("MIGRATION_INPUT_ERROR", error.to_string()))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| ServiceError::new("MIGRATION_INPUT_ERROR", error.to_string()))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| ServiceError::new("MIGRATION_INPUT_ERROR", error.to_string()))?;
    if let Some(missing) = required.iter().find(|column| !columns.contains(**column)) {
        return Err(ServiceError::new(
            "MIGRATION_INPUT_ERROR",
            format!("旧 notes 表缺少 {missing} 列"),
        ));
    }
    Ok(())
}

fn read_folders(
    connection: &Connection,
) -> Result<HashMap<String, (String, Option<String>)>, ServiceError> {
    let mut statement = connection
        .prepare("SELECT id, name, parent_id FROM folders")
        .map_err(|error| ServiceError::new("MIGRATION_INPUT_ERROR", error.to_string()))?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|error| ServiceError::new("MIGRATION_INPUT_ERROR", error.to_string()))?;
    let mut folders = HashMap::new();
    for row in rows {
        let (id, name, parent) =
            row.map_err(|error| ServiceError::new("MIGRATION_INPUT_ERROR", error.to_string()))?;
        folders.insert(id, (name, parent));
    }
    Ok(folders)
}

fn read_notes(connection: &Connection) -> Result<Vec<LegacyNote>, ServiceError> {
    let columns = connection
        .prepare("PRAGMA table_info(notes)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        })
        .map_err(|error| ServiceError::new("MIGRATION_INPUT_ERROR", error.to_string()))?;
    let has = |name: &str| columns.iter().any(|column| column == name);
    let file_path = if has("file_path") {
        "file_path"
    } else {
        "NULL"
    };
    let properties = if has("properties_json") {
        "properties_json"
    } else {
        "NULL"
    };
    let sql = format!(
        "SELECT id,title,content,folder_id,{file_path},is_pinned,created_at,updated_at,{properties} FROM notes ORDER BY updated_at ASC"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| ServiceError::new("MIGRATION_INPUT_ERROR", error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            let properties = row
                .get::<_, Option<String>>(8)?
                .map(|raw| serde_json::from_str::<serde_json::Value>(&raw).unwrap_or_default())
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            Ok(LegacyNote {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                folder_id: row.get(3)?,
                file_path: row.get(4)?,
                is_pinned: row.get::<_, i64>(5)? != 0,
                created_at: row
                    .get::<_, Option<String>>(6)?
                    .unwrap_or_else(|| crate::time::iso8601_utc(crate::time::now_millis())),
                updated_at: row
                    .get::<_, Option<String>>(7)?
                    .unwrap_or_else(|| crate::time::iso8601_utc(crate::time::now_millis())),
                properties,
            })
        })
        .map_err(|error| ServiceError::new("MIGRATION_INPUT_ERROR", error.to_string()))?;
    rows.map(|row| {
        row.map_err(|error| ServiceError::new("MIGRATION_INPUT_ERROR", error.to_string()))
    })
    .collect()
}

fn folder_path(
    folder_id: Option<&str>,
    folders: &HashMap<String, (String, Option<String>)>,
) -> String {
    let mut result = Vec::new();
    let mut current = folder_id;
    let mut visited = HashSet::new();
    while let Some(id) = current.filter(|id| visited.insert((*id).to_owned())) {
        let Some((name, parent)) = folders.get(id) else {
            break;
        };
        result.push(sanitize_file_part(name, "未命名目录"));
        current = parent.as_deref();
    }
    result.reverse();
    result.join("/")
}

fn validate_relative_note_path(path: &str) -> Result<(), ServiceError> {
    let path = path.replace('\\', "/");
    let value = Path::new(&path);
    if path.is_empty()
        || value.is_absolute()
        || !path.to_ascii_lowercase().ends_with(".md")
        || value.components().any(|component| {
            !matches!(component, std::path::Component::Normal(_))
                || component.as_os_str() == "."
                || component.as_os_str() == ".."
        })
    {
        return Err(ServiceError::new(
            "VALIDATION",
            format!("旧笔记路径不安全：{path}"),
        ));
    }
    Ok(())
}

fn path_without_extension(path: &str) -> String {
    path.strip_suffix(".md")
        .or_else(|| path.strip_suffix(".MD"))
        .unwrap_or(path)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::migrate_sqlite;
    use crate::workspace::WorkspaceService;
    use rusqlite::Connection;
    use std::fs;

    fn legacy_db(path: &std::path::Path) {
        let db = Connection::open(path).unwrap();
        db.execute_batch("CREATE TABLE folders(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT); CREATE TABLE notes(id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,folder_id TEXT,is_pinned INTEGER NOT NULL,created_at TEXT,updated_at TEXT,file_path TEXT,properties_json TEXT);").unwrap();
        db.execute("INSERT INTO folders VALUES ('f','项目',NULL)", [])
            .unwrap();
        db.execute("INSERT INTO notes VALUES ('550e8400-e29b-41d4-a716-446655440000','迁移笔记','正文', 'f', 1,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL,'{\"type\":\"memo\"}')", []).unwrap();
    }

    #[test]
    fn migration_requires_both_confirmations_and_preserves_source() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        let source = dir.path().join("legacy.db");
        legacy_db(&source);
        let before = fs::read(&source).unwrap();
        let service = WorkspaceService::open(vault.clone()).unwrap();
        assert_eq!(
            migrate_sqlite(&service, &source.display().to_string(), false, true)
                .unwrap_err()
                .code,
            "CONFIRMATION_REQUIRED"
        );
        let result = migrate_sqlite(&service, &source.display().to_string(), true, true).unwrap();
        assert_eq!(result.migrated.len(), 1);
        assert!(vault.join("项目/迁移笔记.md").exists());
        assert_eq!(before, fs::read(&source).unwrap());
        let repeated = migrate_sqlite(&service, &source.display().to_string(), true, true).unwrap();
        assert_eq!(repeated.skipped.len(), 1);
        assert!(
            result
                .backup_path
                .ends_with("db.bak-before-vault-migration")
        );
    }

    #[test]
    fn migration_rejects_projection_database_and_invalid_schema() {
        let dir = tempfile::tempdir().unwrap();
        let service = WorkspaceService::open(dir.path().join("vault")).unwrap();
        let projection = service.path().join(".lattice/lattice.db");
        assert_eq!(
            migrate_sqlite(&service, &projection.display().to_string(), true, true)
                .unwrap_err()
                .code,
            "VALIDATION"
        );
        let invalid = dir.path().join("invalid.db");
        Connection::open(&invalid).unwrap();
        assert_eq!(
            migrate_sqlite(&service, &invalid.display().to_string(), true, true)
                .unwrap_err()
                .code,
            "MIGRATION_INPUT_ERROR"
        );
    }
}
