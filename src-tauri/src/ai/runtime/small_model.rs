//! 轻量模型调用（地基 §4 `runtime/small_model`，W4 自 `ai_runtime.rs` 迁入）。
//!
//! 有界、非流式的小请求，仅服务意图路由与检索重排：只接受 web 侧拼好的
//! 提示词，prompt / 响应 / 凭据都不进 durable 表。认证头复用协议层 `apply_auth`。
//! W1b：客户端只剩掩码/空 Key（密钥在 env/keyring）时，按 provider id 解析补齐。

use crate::ai::core::provider::protocol::{self, ProviderConfig, apply_auth};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmallModelProvider {
    /// 密钥服务解析的锚点（W1b）：env/keyring 按 provider id 取真实密钥
    #[serde(default)]
    pub id: Option<String>,
    #[serde(flatten)]
    pub config: ProviderConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmallModelRequest {
    provider: SmallModelProvider,
    task: String,
    input: String,
}

/// 请求里的掩码/空 Key 按 env→keyring 优先级补齐（真实密钥只在本次调用的内存）。
fn resolve_small_model_config(provider: SmallModelProvider) -> ProviderConfig {
    let mut config = provider.config;
    if config.api_key.trim().is_empty() || config.api_key.trim_start().starts_with("masked:") {
        if let Some(provider_id) = provider.id.as_deref()
            && let Some(resolved) = crate::ai::core::config::resolve_secret(provider_id)
        {
            config.api_key = resolved;
        }
    }
    config
}

/// Bounded, non-streaming call for optional intent routing and candidate reranking.
/// It deliberately accepts only a prompt assembled by the web client and never
/// stores the prompt, response, or credentials in the durable Run tables.
#[tauri::command]
pub async fn ai_small_model(request: SmallModelRequest) -> Result<Value, String> {
    if !matches!(request.task.as_str(), "intent" | "rerank") {
        return Err("轻量模型任务类型无效".to_owned());
    }
    if request.input.trim().is_empty() || request.input.chars().count() > 8_000 {
        return Err("轻量模型输入过长或为空".to_owned());
    }
    let provider = resolve_small_model_config(request.provider);
    if provider.endpoint.trim().is_empty() || provider.model.trim().is_empty() {
        return Err("轻量模型配置不完整".to_owned());
    }
    if !provider.endpoint.starts_with("http://")
        && !provider.endpoint.starts_with("https://")
    {
        return Err("轻量模型地址必须使用 HTTP 或 HTTPS".to_owned());
    }
    if !provider.endpoint.starts_with("http://127.0.0.1")
        && !provider.endpoint.starts_with("http://localhost")
        && provider.api_key.trim().is_empty()
    {
        return Err("轻量模型缺少 API Key".to_owned());
    }

    let body = json!({
        "model": provider.model,
        "messages": [{ "role": "user", "content": request.input }],
        "temperature": 0,
        "max_tokens": provider.max_tokens.unwrap_or(512).min(512),
        "stream": false,
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "轻量模型客户端初始化失败".to_owned())?;
    let builder = client
        .post(&provider.endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body);
    let builder = apply_auth(
        builder,
        &provider.api_key,
        &provider.auth_header,
        "轻量模型",
    )?;
    let response = builder
        .send()
        .await
        .map_err(|_| "轻量模型连接失败".to_owned())?;
    if !response.status().is_success() {
        return Err(
            protocol::provider_http_error(response, "轻量模型请求失败").await,
        );
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "轻量模型返回了无效 JSON".to_owned())?;
    let text = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/choices/0/text").and_then(Value::as_str))
        .ok_or_else(|| "轻量模型响应缺少文本".to_owned())?;
    Ok(json!({ "text": text.chars().take(8_000).collect::<String>() }))
}

#[cfg(test)]
mod tests {
    use super::{SmallModelProvider, resolve_small_model_config};
    use serde_json::json;

    /// 掩码占位（运行时拼接，不写凭据形态字面量——W9 扫描红线同样约束本文件）
    fn masked_placeholder() -> String {
        format!("masked:{}", "abcd")
    }

    fn provider(payload: serde_json::Value) -> SmallModelProvider {
        serde_json::from_value(payload).expect("小模型 provider 载荷应可反序列化")
    }

    #[test]
    fn small_model_payload_accepts_provider_id_and_parses_fields() {
        // 载荷里带 id（web 运行时视图原样透传）；掩码 Key 在无密钥服务条目时保持原样，
        // 由上层校验拒绝——这里只验证解析路径不报错、字段齐全。
        let parsed = provider(json!({
            "id": "w1b-small-model-unknown",
            "endpoint": "https://example.com/v1",
            "model": "m",
            "authHeader": "bearer",
            "apiKey": masked_placeholder(),
            "temperature": 0.1,
        }));
        let config = resolve_small_model_config(parsed);
        assert_eq!(config.model, "m");
        assert_eq!(config.temperature, Some(0.1));
    }

    #[cfg(windows)]
    #[test]
    fn small_model_resolves_keyring_key_by_provider_id() {
        let _guard = crate::ai::core::config::secrets::KEYRING_TEST_GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let fake = format!("w1b-small-{}key", "demo-");
        crate::ai::core::config::store_secret("w1b-small-model-resolve", &fake)
            .expect("写入凭据管理器");
        let parsed = provider(json!({
            "id": "w1b-small-model-resolve",
            "endpoint": "https://example.com/v1",
            "model": "m",
            "apiKey": masked_placeholder(),
        }));
        // 凭据管理器在并行负载下偶发读延迟，小步重试再断言
        let mut config = resolve_small_model_config(parsed);
        for _ in 0..5 {
            if config.api_key == fake { break; }
            std::thread::sleep(std::time::Duration::from_millis(50));
            let parsed = provider(json!({
                "id": "w1b-small-model-resolve",
                "endpoint": "https://example.com/v1",
                "model": "m",
                "apiKey": masked_placeholder(),
            }));
            config = resolve_small_model_config(parsed);
        }
        assert_eq!(config.api_key, fake, "掩码按 provider id 从密钥服务补齐");
        crate::ai::core::config::delete_secret("w1b-small-model-resolve").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn small_model_real_key_passes_through_without_lookup() {
        let fake = format!("w1b-small-{}plain", "demo-");
        let parsed = provider(json!({
            "id": "w1b-small-model-passthrough",
            "endpoint": "https://example.com/v1",
            "model": "m",
            "apiKey": fake,
        }));
        let config = resolve_small_model_config(parsed);
        assert_eq!(config.api_key, fake, "客户端带来的真实密钥不触发解析");
    }
}
