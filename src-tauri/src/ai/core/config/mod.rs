//! AI 设置存储（地基方案 §5.2，执行方案 W1）。
//!
//! SQLite `ai_settings` 表只存**脱敏文档**，密钥永不落盘：
//! - 保存时在 Rust 边界做字段白名单裁剪，真实 API Key 只保留 `masked:后四位`
//!   掩码（与 web 侧 `masked:` 前缀约定一致）；
//! - 保存载荷**缺** `apiKey` 字段时沿用该 provider 此前保存的掩码
//!   （对应编辑表单「已配置，留空保持不变」）；
//! - `apiKey` 为空串表示显式清除；已带 `masked:` 前缀的值原样保留（回显）。
//!
//! 读取侧由 `WorkspaceService::ai_settings_load` 为每个 provider 附 `keyAvailable`
//! （密钥能否从环境变量解析，见 `secrets.rs`）。

use crate::db;
use crate::time::{iso8601_utc, now_millis};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value, json};
use std::path::Path;
use std::sync::Mutex;

pub(crate) mod secrets;

pub use secrets::{delete_secret, env_secret, keyring_secret, resolve_secret, store_secret};

/// 设置表永远只有一行。
const SETTINGS_ROW_ID: i64 = 1;
const MAX_PROVIDERS: usize = 32;
const MASK_PREFIX: &str = "masked:";
/// 短于该长度的密钥不展示尾四位，避免掩码泄漏全部内容。
const MIN_KEY_LENGTH_FOR_TAIL: usize = 8;

pub struct AiSettingsStore {
    connection: Mutex<Connection>,
}

impl AiSettingsStore {
    pub fn open(database: &Path) -> Result<Self, String> {
        Ok(Self {
            connection: Mutex::new(db::open(database)?),
        })
    }

    /// 读取脱敏文档；从未保存过时返回空对象。
    pub fn load(&self) -> Result<Value, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|error| error.to_string())?;
        load_document(&connection)
    }

    /// 保存：白名单脱敏后整文档覆盖写入，返回脱敏结果。
    pub fn save(&self, document: &Value) -> Result<Value, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|error| error.to_string())?;
        let previous = load_document(&connection)?;
        let sanitized = sanitize_document(document, &previous)?;
        let serialized = serde_json::to_string(&sanitized)
            .map_err(|error| format!("无法序列化 AI 设置：{error}"))?;
        connection
            .execute(
                "INSERT INTO ai_settings (id, document, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET
                   document = excluded.document,
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    SETTINGS_ROW_ID,
                    serialized,
                    iso8601_utc(now_millis())
                ],
            )
            .map_err(|error| format!("无法写入 AI 设置：{error}"))?;
        Ok(sanitized)
    }
}

fn load_document(connection: &Connection) -> Result<Value, String> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT document FROM ai_settings WHERE id = ?1",
            [SETTINGS_ROW_ID],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("无法读取 AI 设置：{error}"))?;
    match stored {
        Some(raw) => {
            serde_json::from_str(&raw).map_err(|error| format!("AI 设置文档损坏：{error}"))
        }
        None => Ok(json!({})),
    }
}

fn sanitize_document(document: &Value, previous: &Value) -> Result<Value, String> {
    let object = document
        .as_object()
        .ok_or_else(|| "AI 设置文档必须是对象".to_owned())?;
    let providers = object
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| "AI 设置文档缺少 providers 数组".to_owned())?;
    if providers.len() > MAX_PROVIDERS {
        return Err(format!("AI 模型配置最多 {MAX_PROVIDERS} 个"));
    }

    let previous_providers = previous
        .get("providers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_str)?;
                    let key = item.get("apiKey").and_then(Value::as_str)?;
                    Some((id.to_owned(), key.to_owned()))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut sanitized_providers = Vec::with_capacity(providers.len());
    for provider in providers {
        let id = provider.get("id").and_then(Value::as_str);
        let previous_mask = previous_providers
            .iter()
            .find(|(previous_id, _)| id == Some(previous_id.as_str()))
            .map(|(_, key)| key.as_str());
        sanitized_providers.push(sanitize_provider(provider, previous_mask)?);
    }

    let mut clean = Map::new();
    clean.insert("providers".to_owned(), Value::Array(sanitized_providers));
    if let Some(active) = bounded_string(object.get("activeProviderId"), 120) {
        clean.insert("activeProviderId".to_owned(), json!(active));
    }
    if let Some(embedding) = object
        .get("embedding")
        .filter(|value| !value.is_null())
    {
        let previous_mask = previous
            .get("embedding")
            .and_then(|value| value.get("apiKey"))
            .and_then(Value::as_str);
        clean.insert(
            "embedding".to_owned(),
            sanitize_embedding(embedding, previous_mask)?,
        );
    }
    Ok(Value::Object(clean))
}

fn sanitize_provider(provider: &Value, previous_mask: Option<&str>) -> Result<Value, String> {
    let object = provider
        .as_object()
        .ok_or_else(|| "AI 模型配置必须是对象".to_owned())?;
    let id = bounded_string(object.get("id"), 120)
        .ok_or_else(|| "AI 模型配置缺少有效 id".to_owned())?;
    let endpoint = bounded_string(object.get("endpoint"), 500)
        .ok_or_else(|| format!("AI 模型 {id} 缺少有效 endpoint"))?;
    let model = bounded_string(object.get("model"), 120)
        .ok_or_else(|| format!("AI 模型 {id} 缺少有效 model"))?;

    let mut clean = Map::new();
    clean.insert("id".to_owned(), json!(id));
    if let Some(name) = bounded_string(object.get("name"), 80) {
        clean.insert("name".to_owned(), json!(name));
    }
    if let Some(service) = bounded_string(object.get("service"), 80) {
        clean.insert("service".to_owned(), json!(service));
    }
    clean.insert("endpoint".to_owned(), json!(endpoint));
    clean.insert("model".to_owned(), json!(model));
    if let Some(auth_header) = bounded_string(object.get("authHeader"), 32) {
        clean.insert("authHeader".to_owned(), json!(auth_header));
    }
    if let Some(enabled) = object.get("enabled").and_then(Value::as_bool) {
        clean.insert("enabled".to_owned(), json!(enabled));
    }
    if let Some(temperature) = object
        .get("temperature")
        .and_then(Value::as_f64)
        .filter(|value| (0.0..=2.0).contains(value))
    {
        clean.insert("temperature".to_owned(), json!(temperature));
    }
    for key in ["maxTokens", "contextWindowTokens"] {
        if let Some(value) = object
            .get(key)
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
        {
            clean.insert(key.to_owned(), json!(value));
        }
    }
    clean.insert(
        "apiKey".to_owned(),
        json!(masked_api_key(object.get("apiKey"), previous_mask)),
    );
    Ok(Value::Object(clean))
}

fn sanitize_embedding(embedding: &Value, previous_mask: Option<&str>) -> Result<Value, String> {
    let object = embedding
        .as_object()
        .ok_or_else(|| "embedding 配置必须是对象".to_owned())?;
    let endpoint = bounded_string(object.get("endpoint"), 500)
        .ok_or_else(|| "embedding 配置缺少有效 endpoint".to_owned())?;
    let model = bounded_string(object.get("model"), 120)
        .ok_or_else(|| "embedding 配置缺少有效 model".to_owned())?;

    let mut clean = Map::new();
    clean.insert("endpoint".to_owned(), json!(endpoint));
    clean.insert("model".to_owned(), json!(model));
    if let Some(name) = bounded_string(object.get("name"), 80) {
        clean.insert("name".to_owned(), json!(name));
    }
    if let Some(auth_header) = bounded_string(object.get("authHeader"), 32) {
        clean.insert("authHeader".to_owned(), json!(auth_header));
    }
    clean.insert(
        "apiKey".to_owned(),
        json!(masked_api_key(object.get("apiKey"), previous_mask)),
    );
    Ok(Value::Object(clean))
}

/// apiKey 四态：缺省 → 沿用旧掩码；空串 → 清除；`masked:` 前缀 → 原样；真实值 → 只留尾四位。
fn masked_api_key(value: Option<&Value>, previous_mask: Option<&str>) -> String {
    match value {
        None => previous_mask.unwrap_or("").to_owned(),
        Some(Value::String(raw)) if raw.is_empty() => String::new(),
        Some(Value::String(raw)) if raw.starts_with(MASK_PREFIX) => raw.clone(),
        Some(Value::String(raw)) => {
            let characters: Vec<char> = raw.chars().collect();
            if characters.len() < MIN_KEY_LENGTH_FOR_TAIL {
                format!("{MASK_PREFIX}****")
            } else {
                let tail: String = characters[characters.len() - 4..].iter().collect();
                format!("{MASK_PREFIX}{tail}")
            }
        }
        _ => String::new(),
    }
}

fn bounded_string(value: Option<&Value>, limit: usize) -> Option<String> {
    let raw = value?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(raw.chars().take(limit).collect())
}

#[cfg(test)]
mod tests {
    use super::{AiSettingsStore, masked_api_key};
    use serde_json::json;

    /// 测试专用：拼装出的明显非凭据字符串（源码中不出现凭据形态字面量），
    /// 只用于验证「真实密钥 → 掩码」的脱敏行为。
    fn demo_key(seed: &str) -> String {
        format!("demo-key-not-a-secret-{seed}")
    }

    #[test]
    fn real_keys_are_masked_and_unknown_fields_dropped() {
        let store = temp_store();
        let sanitized = store
            .save(&json!({
                "providers": [{
                    "id": "provider-a",
                    "name": "DeepSeek",
                    "service": "DeepSeek",
                    "endpoint": "https://api.deepseek.com/chat/completions",
                    "model": "deepseek-chat",
                    "authHeader": "bearer",
                    "enabled": true,
                    "apiKey": demo_key("abcd"),
                    "temperature": 0.2,
                    "maxTokens": 4096,
                    "contextWindowTokens": 128000,
                    "evilField": "必须被白名单裁掉"
                }],
                "activeProviderId": "provider-a",
                "embedding": {
                    "endpoint": "https://api.siliconflow.cn/v1/embeddings",
                    "model": "BAAI/bge-m3",
                    "name": "Embedding",
                    "authHeader": "bearer",
                    "apiKey": demo_key("wxyz"),
                    "evilField": "同样裁掉"
                },
                "unknownTopLevel": "裁掉"
            }))
            .unwrap();

        let provider = &sanitized["providers"][0];
        assert_eq!(provider["apiKey"], "masked:abcd");
        assert_eq!(provider["maxTokens"], 4096);
        assert!(provider.get("evilField").is_none());
        assert_eq!(sanitized["embedding"]["apiKey"], "masked:wxyz");
        assert!(sanitized["embedding"].get("evilField").is_none());
        assert!(sanitized.get("unknownTopLevel").is_none());
        // 落盘返回值绝不含原始演示串
        assert!(!sanitized.to_string().contains("demo-key-not-a-secret"));
    }

    #[test]
    fn absent_key_carries_previous_mask_and_empty_clears() {
        let store = temp_store();
        store
            .save(&json!({
                "providers": [{
                    "id": "provider-a",
                    "endpoint": "https://api.example.com/v1/chat/completions",
                    "model": "model-1",
                    "apiKey": demo_key("abcd")
                }],
                "activeProviderId": "provider-a"
            }))
            .unwrap();

        // 编辑其它字段、留空（载荷缺 apiKey）→ 掩码沿用
        let edited = store
            .save(&json!({
                "providers": [{
                    "id": "provider-a",
                    "endpoint": "https://api.example.com/v1/chat/completions",
                    "model": "model-2"
                }],
                "activeProviderId": "provider-a"
            }))
            .unwrap();
        assert_eq!(edited["providers"][0]["apiKey"], "masked:abcd");
        assert_eq!(edited["providers"][0]["model"], "model-2");

        // 显式空串 → 清除
        let cleared = store
            .save(&json!({
                "providers": [{
                    "id": "provider-a",
                    "endpoint": "https://api.example.com/v1/chat/completions",
                    "model": "model-2",
                    "apiKey": ""
                }],
                "activeProviderId": "provider-a"
            }))
            .unwrap();
        assert_eq!(cleared["providers"][0]["apiKey"], "");
    }

    #[test]
    fn short_real_key_masks_without_leaking_tail() {
        assert_eq!(masked_api_key(Some(&json!("short7!")), None), "masked:****");
        assert_eq!(
            masked_api_key(Some(&json!("masked:keep")), None),
            "masked:keep"
        );
        assert_eq!(masked_api_key(None, Some("masked:1234")), "masked:1234");
    }

    #[test]
    fn save_and_load_roundtrip_and_provider_cap() {
        let store = temp_store();
        let document = json!({
            "providers": [{
                "id": "provider-local",
                "endpoint": "http://127.0.0.1:11434/v1/chat/completions",
                "model": "qwen3:14b",
                "apiKey": ""
            }],
            "activeProviderId": "provider-local"
        });
        store.save(&document).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded["activeProviderId"], "provider-local");
        assert_eq!(loaded["providers"][0]["apiKey"], "");

        // 空库首次读取返回空对象
        assert_eq!(temp_store().load().unwrap(), json!({}));

        let too_many = json!({
            "providers": (0..33).map(|index| json!({
                "id": format!("provider-{index}"),
                "endpoint": "https://api.example.com/v1/chat/completions",
                "model": "model"
            })).collect::<Vec<_>>()
        });
        assert!(store.save(&too_many).is_err());
    }

    fn temp_store() -> AiSettingsStore {
        let directory = tempfile::tempdir().unwrap();
        AiSettingsStore::open(&directory.path().join("lattice.db")).unwrap()
    }
}
