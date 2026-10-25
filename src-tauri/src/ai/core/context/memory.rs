//! 用户可控的 AI 记忆存储（地基 §5 `context/memory`，W7c 自 `src/memory.rs` 物理迁入）。
//!
//! 只有显式调用保存命令才会写入；模型运行时没有本模块的写权限。
//! 敏感信息检查在 Rust 边界执行，避免依赖前端或模型自觉脱敏。

use crate::db;
use crate::time::{iso8601_utc, now_millis};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

const MAX_CONTENT_LENGTH: usize = 12_000;
const MAX_SOURCE_LENGTH: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub kind: String,
    pub content: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: Option<String>,
    pub expired: bool,
}

pub struct MemoryStore {
    connection: Mutex<Connection>,
}

impl MemoryStore {
    pub fn open(database: &Path) -> Result<Self, String> {
        Ok(Self {
            connection: Mutex::new(db::open(database)?),
        })
    }

    pub fn list(&self, include_expired: bool) -> Result<Vec<MemoryRecord>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let now = iso8601_utc(now_millis());
        let mut statement = connection
            .prepare(if include_expired {
                "SELECT id, kind, content, source, created_at, updated_at, expires_at
                     FROM ai_memories ORDER BY updated_at DESC, id DESC"
            } else {
                "SELECT id, kind, content, source, created_at, updated_at, expires_at
                     FROM ai_memories
                     WHERE expires_at IS NULL OR expires_at > ?1
                     ORDER BY updated_at DESC, id DESC"
            })
            .map_err(|error| error.to_string())?;
        let rows = if include_expired {
            statement
                .query_map([], |row| Self::record_from_row(row, &now))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
        } else {
            statement
                .query_map([&now], |row| Self::record_from_row(row, &now))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
        };
        rows.map_err(|error| error.to_string())
    }

    pub fn save(
        &self,
        id: Option<String>,
        kind: &str,
        content: &str,
        source: &str,
        expires_at: Option<&str>,
    ) -> Result<MemoryRecord, MemoryError> {
        validate_kind(kind)?;
        let content = content.trim();
        if content.is_empty() {
            return Err(MemoryError::Validation("记忆内容不能为空".into()));
        }
        if content.chars().count() > MAX_CONTENT_LENGTH {
            return Err(MemoryError::Validation(format!(
                "记忆内容不能超过 {MAX_CONTENT_LENGTH} 个字符"
            )));
        }
        let source = source.trim();
        if source.is_empty() || source.chars().count() > MAX_SOURCE_LENGTH {
            return Err(MemoryError::Validation(format!(
                "来源不能为空且不能超过 {MAX_SOURCE_LENGTH} 个字符"
            )));
        }
        if let Some(reason) = sensitive_reason(content) {
            return Err(MemoryError::Sensitive(reason));
        }
        let expires_at = normalize_expiry(expires_at)?;
        let now = iso8601_utc(now_millis());
        let id = id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let connection = self
            .connection
            .lock()
            .map_err(|error| MemoryError::Storage(error.to_string()))?;
        let existing: Option<(String, String)> = connection
            .query_row(
                "SELECT created_at, kind FROM ai_memories WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| MemoryError::Storage(error.to_string()))?;
        let created_at = existing
            .as_ref()
            .map(|value| value.0.as_str())
            .unwrap_or(&now);
        if let Some((_, existing_kind)) = &existing
            && existing_kind != kind
        {
            return Err(MemoryError::Validation(
                "不能改变记忆类型，请删除后重新创建".into(),
            ));
        }
        connection
            .execute(
                "INSERT INTO ai_memories (id, kind, content, source, created_at, updated_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                   content = excluded.content,
                   source = excluded.source,
                   updated_at = excluded.updated_at,
                   expires_at = excluded.expires_at",
                params![id, kind, content, source, created_at, now, expires_at],
            )
            .map_err(|error| MemoryError::Storage(error.to_string()))?;
        Ok(MemoryRecord {
            id,
            kind: kind.to_owned(),
            content: content.to_owned(),
            source: source.to_owned(),
            created_at: created_at.to_owned(),
            updated_at: now,
            expired: expires_at
                .as_deref()
                .is_some_and(|value| value <= iso8601_utc(now_millis()).as_str()),
            expires_at,
        })
    }

    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection
            .execute("DELETE FROM ai_memories WHERE id = ?1", [id])
            .map(|count| count > 0)
            .map_err(|error| error.to_string())
    }

    fn record_from_row(row: &rusqlite::Row<'_>, now: &str) -> rusqlite::Result<MemoryRecord> {
        let expires_at: Option<String> = row.get(6)?;
        Ok(MemoryRecord {
            id: row.get(0)?,
            kind: row.get(1)?,
            content: row.get(2)?,
            source: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
            expired: expires_at.as_deref().is_some_and(|value| value <= now),
            expires_at,
        })
    }
}

#[derive(Debug)]
pub enum MemoryError {
    Validation(String),
    Sensitive(String),
    Storage(String),
}

impl std::fmt::Display for MemoryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation(message) => write!(formatter, "VALIDATION: {message}"),
            Self::Sensitive(message) => write!(formatter, "SENSITIVE_CONTENT: {message}"),
            Self::Storage(message) => write!(formatter, "STORAGE_ERROR: {message}"),
        }
    }
}

fn validate_kind(kind: &str) -> Result<(), MemoryError> {
    if matches!(kind, "preference" | "knowledge") {
        Ok(())
    } else {
        Err(MemoryError::Validation(
            "记忆类型必须是 preference 或 knowledge".into(),
        ))
    }
}

fn normalize_expiry(value: Option<&str>) -> Result<Option<String>, MemoryError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parsed = chrono_like::DateTime::parse(value);
    if parsed.is_err() {
        return Err(MemoryError::Validation(
            "过期时间必须是 ISO-8601 时间".into(),
        ));
    }
    Ok(Some(value.to_owned()))
}

fn sensitive_reason(content: &str) -> Option<String> {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            (Regex::new(r"(?i)(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|authorization|bearer)\s*[:=]?").unwrap(), "疑似密钥、令牌、密码或授权信息"),
            (Regex::new(r"(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----").unwrap(), "疑似私钥"),
            (Regex::new(r"\bsk-[A-Za-z0-9]{20,}\b").unwrap(), "疑似 API 密钥"),
            (Regex::new(r"(?:^|[^\d])1[3-9]\d{9}(?:$|[^\d])").unwrap(), "疑似手机号"),
            (Regex::new(r"(?:^|[^\d])\d{17}[\dXx](?:$|[^\d])").unwrap(), "疑似身份证号码"),
            (Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b").unwrap(), "疑似邮箱地址"),
        ]
    });
    patterns
        .iter()
        .find(|(pattern, _)| pattern.is_match(content))
        .map(|(_, reason)| (*reason).to_owned())
}

// Small ISO-8601 shape validator; timestamps are kept as strings for stable
// lexical comparisons and to avoid introducing a date-time dependency.
mod chrono_like {
    pub struct DateTime;
    impl DateTime {
        pub fn parse(value: &str) -> Result<Self, ()> {
            let bytes = value.as_bytes();
            if bytes.len() < 20
                || bytes.get(4) != Some(&b'-')
                || bytes.get(7) != Some(&b'-')
                || !value.contains('T')
            {
                return Err(());
            }
            if value.chars().any(|ch| ch.is_control()) {
                return Err(());
            }
            Ok(Self)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MemoryError, MemoryStore, sensitive_reason};

    #[test]
    fn rejects_sensitive_content_before_persisting() {
        assert!(sensitive_reason("api_key = sk-test-secret").is_some());
        assert!(sensitive_reason("我的手机号是 13812345678").is_some());
        assert!(sensitive_reason("联系 me@example.com").is_some());
    }

    #[test]
    fn saves_lists_filters_expired_and_deletes() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("lattice.db");
        let store = MemoryStore::open(&database).unwrap();
        let saved = store
            .save(None, "preference", "偏好简洁回答", "用户设置", None)
            .unwrap();
        assert_eq!(store.list(false).unwrap().len(), 1);
        assert_eq!(store.list(true).unwrap()[0].id, saved.id);
        let expired = store
            .save(
                None,
                "knowledge",
                "旧知识",
                "测试",
                Some("2020-01-01T00:00:00.000Z"),
            )
            .unwrap();
        assert_eq!(store.list(false).unwrap().len(), 1);
        assert_eq!(store.list(true).unwrap().len(), 2);
        assert!(
            store
                .list(true)
                .unwrap()
                .iter()
                .any(|item| item.id == expired.id && item.expired)
        );
        assert!(store.delete(&saved.id).unwrap());
        assert!(!store.delete(&saved.id).unwrap());
    }

    #[test]
    fn rejected_content_does_not_create_row() {
        let directory = tempfile::tempdir().unwrap();
        let store = MemoryStore::open(&directory.path().join("lattice.db")).unwrap();
        let error = store
            .save(None, "knowledge", "password: hunter2", "test", None)
            .unwrap_err();
        assert!(matches!(error, MemoryError::Sensitive(_)));
        assert!(store.list(true).unwrap().is_empty());
    }
}
