//! 协议层公共件：跨协议共享的工具名校验、上游错误提取与认证头组装。
//! 协议差异（请求体形状、SSE 事件结构）在各协议子模块内实现。

pub(crate) mod openai;

pub(crate) use openai::{
    ProviderConfig, ReasoningSplitter, ToolCallAccumulator, append_tool_call_deltas,
    build_chat_request, extract_delta, finish_tool_calls, provider_from_request,
};

use reqwest::header::{AUTHORIZATION, HeaderName, HeaderValue};
use serde_json::Value;

pub(crate) const MAX_PROVIDER_TOOLS: usize = 64;
pub(crate) const MAX_TOOL_NAME_LENGTH: usize = 96;
pub(crate) const MAX_TOOL_ARGUMENTS_LENGTH: usize = 64 * 1024;

pub(crate) fn valid_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_TOOL_NAME_LENGTH
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
}

fn upstream_error_detail(body: &str) -> Option<String> {
    let payload: Value = serde_json::from_str(body).ok()?;
    let detail = [
        payload.pointer("/error/message"),
        payload.pointer("/message"),
        payload.pointer("/error"),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_str)?
    .trim();
    if detail.is_empty() {
        return None;
    }
    Some(detail.chars().take(300).collect())
}

pub(crate) async fn provider_http_error(response: reqwest::Response, label: &str) -> String {
    let status = response.status().as_u16();
    let detail = response
        .text()
        .await
        .ok()
        .and_then(|body| upstream_error_detail(&body));
    match detail {
        Some(detail) => format!("{label}（HTTP {status}）：{detail}"),
        None => format!("{label}（HTTP {status}）"),
    }
}

/// 统一认证头组装：`Authorization: Bearer <key>` 或 `x-api-key: <key>`。
/// 密钥只进入请求头，不进日志、不进错误信息。
pub(crate) fn apply_auth(
    mut builder: reqwest::RequestBuilder,
    api_key: &str,
    auth_header: &str,
    label: &str,
) -> Result<reqwest::RequestBuilder, String> {
    if api_key.trim().is_empty() {
        return Ok(builder);
    }
    if auth_header == "x-api-key" {
        builder = builder.header(
            HeaderName::from_static("x-api-key"),
            HeaderValue::try_from(api_key.trim()).map_err(|_| format!("{label} API Key 无效"))?,
        );
    } else {
        builder = builder.header(
            AUTHORIZATION,
            HeaderValue::try_from(format!("Bearer {}", api_key.trim()))
                .map_err(|_| format!("{label} API Key 无效"))?,
        );
    }
    Ok(builder)
}

#[cfg(test)]
mod tests {
    use super::upstream_error_detail;

    #[test]
    fn upstream_auth_error_detail_is_extracted_without_raw_body() {
        let detail = upstream_error_detail(
            r#"{"error":{"code":"","message":"无效的令牌 (request id: secret-not-a-key)","type":"AgnesAI_error"}}"#,
        )
        .unwrap();
        assert_eq!(detail, "无效的令牌 (request id: secret-not-a-key)");
        assert!(upstream_error_detail(r#"{"error":{"message":""}}"#).is_none());
        assert!(upstream_error_detail("not-json").is_none());
    }
}
