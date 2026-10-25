//! 连通性与能力探测（地基方案 §5.1 probe）：对已配置端点发一次最小 chat / embedding /
//! tools 请求。密钥只用于本次请求；返回只含状态、时延、向量维度与工具能力判定，
//! 不含请求或响应正文。

use super::protocol::openai::{ProviderConfig, validate_provider_config};
use super::protocol::{apply_auth, provider_http_error};
use serde_json::{Value, json};

pub(crate) async fn run_provider_test(request: Value) -> Result<Value, String> {
    let provider_value = request
        .get("provider")
        .cloned()
        .ok_or_else(|| "桌面端 AI 测试缺少模型配置".to_owned())?;
    let provider: ProviderConfig =
        serde_json::from_value(provider_value).map_err(|_| "桌面端 AI 模型配置无效".to_owned())?;
    validate_provider_config(&provider)?;
    let kind = request
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("chat");
    if !matches!(kind, "chat" | "embedding" | "tools") {
        return Err("桌面端 AI 测试类型无效".to_owned());
    }
    if kind == "tools" {
        return run_provider_tools_probe(provider).await;
    }
    let body = if kind == "embedding" {
        json!({
            "model": provider.model.clone(),
            "input": "lattice connectivity test",
        })
    } else {
        json!({
            "model": provider.model.clone(),
            "messages": [{ "role": "user", "content": "Reply with OK." }],
            "temperature": 0,
            "max_tokens": 8,
            "stream": false,
        })
    };
    let started = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "桌面端 AI 测试客户端初始化失败".to_owned())?;
    let builder = client
        .post(&provider.endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body);
    let builder = apply_auth(builder, &provider.api_key, &provider.auth_header, "桌面端 AI 测试")?;
    let response = builder
        .send()
        .await
        .map_err(|_| "桌面端 AI 测试无法连接模型服务".to_owned())?;
    let latency_ms = started.elapsed().as_millis() as u64;
    if !response.status().is_success() {
        return Err(provider_http_error(response, "桌面端 AI 测试失败").await);
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "桌面端 AI 测试返回了无效 JSON".to_owned())?;
    let mut result = json!({ "ok": true, "latencyMs": latency_ms });
    if kind == "embedding" {
        let dimension = payload
            .pointer("/data/0/embedding")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        if dimension == 0 {
            return Err("桌面端 AI 测试响应缺少 embedding 向量".to_owned());
        }
        result["dim"] = json!(dimension);
    }
    Ok(result)
}

/// W7c 能力实测（协商链第三环：目录声明 → 发现补充 → probe 实测 → trace 回写）：
/// 带 tools 的最小 chat 请求，验证端点与模型是否接受工具调用面。
/// 判定：请求被上游接受（2xx）→ `nativeTools: true`；上游因工具参数明确拒绝
/// （4xx 且报文指向 tools/function）→ `nativeTools: false`（任务模式据此置灰）；
/// 其余错误按连通性失败照常报错。响应只回判定、时延与诊断字段，不落盘正文。
async fn run_provider_tools_probe(provider: ProviderConfig) -> Result<Value, String> {
    let body = json!({
        "model": provider.model.clone(),
        "messages": [{ "role": "user", "content": "Call the provided tool to report readiness. Do not answer in plain text." }],
        "tools": [{ "type": "function", "function": {
            "name": "lattice_probe_ready",
            "description": "Report that tool calling works.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }}],
        "tool_choice": "auto",
        "temperature": 0,
        "max_tokens": 64,
        "stream": false,
    });
    let started = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "桌面端 AI 测试客户端初始化失败".to_owned())?;
    let builder = client
        .post(&provider.endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body);
    let builder = apply_auth(builder, &provider.api_key, &provider.auth_header, "桌面端 AI 测试")?;
    let response = builder
        .send()
        .await
        .map_err(|_| "桌面端 AI 测试无法连接模型服务".to_owned())?;
    let latency_ms = started.elapsed().as_millis() as u64;
    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        let lower = body_text.to_lowercase();
        let tool_rejected = status.is_client_error()
            && (lower.contains("tool") || lower.contains("function") || lower.contains("not support"));
        if tool_rejected {
            return Ok(json!({
                "ok": true,
                "latencyMs": latency_ms,
                "nativeTools": false,
                "status": status.as_u16(),
                "reason": "上游拒绝了工具调用参数",
            }));
        }
        return Err(provider_http_error_text(status, &body_text, "桌面端 AI 测试失败"));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "桌面端 AI 测试返回了无效 JSON".to_owned())?;
    let emitted = payload
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|calls| !calls.is_empty());
    let finish_reason = payload
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok(json!({
        "ok": true,
        "latencyMs": latency_ms,
        "nativeTools": true,
        "toolCallsEmitted": emitted,
        "finishReason": finish_reason,
    }))
}

/// provider_http_error 的纯文本变体：报错信息不含密钥，只带状态码与截断后的上游报文。
fn provider_http_error_text(status: reqwest::StatusCode, body: &str, prefix: &str) -> String {
    let truncated: String = body.chars().take(300).collect();
    format!("{prefix}（HTTP {}）：{truncated}", status.as_u16())
}
