//! 轻量模型调用（地基 §4 `runtime/small_model`，W4 自 `ai_runtime.rs` 迁入）。
//!
//! 有界、非流式的小请求，仅服务意图路由与检索重排：只接受 web 侧拼好的
//! 提示词，prompt / 响应 / 凭据都不进 durable 表。认证头复用协议层 `apply_auth`。

use crate::ai::core::provider::protocol::{self, ProviderConfig, apply_auth};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmallModelRequest {
    provider: ProviderConfig,
    task: String,
    input: String,
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
    if request.provider.endpoint.trim().is_empty() || request.provider.model.trim().is_empty() {
        return Err("轻量模型配置不完整".to_owned());
    }
    if !request.provider.endpoint.starts_with("http://")
        && !request.provider.endpoint.starts_with("https://")
    {
        return Err("轻量模型地址必须使用 HTTP 或 HTTPS".to_owned());
    }
    if !request.provider.endpoint.starts_with("http://127.0.0.1")
        && !request.provider.endpoint.starts_with("http://localhost")
        && request.provider.api_key.trim().is_empty()
    {
        return Err("轻量模型缺少 API Key".to_owned());
    }

    let body = json!({
        "model": request.provider.model,
        "messages": [{ "role": "user", "content": request.input }],
        "temperature": 0,
        "max_tokens": request.provider.max_tokens.unwrap_or(512).min(512),
        "stream": false,
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "轻量模型客户端初始化失败".to_owned())?;
    let builder = client
        .post(&request.provider.endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body);
    let builder = apply_auth(
        builder,
        &request.provider.api_key,
        &request.provider.auth_header,
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
