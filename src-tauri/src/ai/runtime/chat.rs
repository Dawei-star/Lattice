//! 聊天流（地基 §4 `runtime/chat`，W4 自 `ai_runtime.rs` 迁入）。
//!
//! 只管 run 生命周期内的流式编排：调用 `core/provider` 的协议层发请求、
//! 把归一化事件（meta/delta/reasoning/tool_call/done）发到 Tauri 事件与 sink、
//! 处理取消。协议差异（SSE 形状、`<think>` 归一、工具累积）全部封在协议层。

use super::run_worker::AiRuntimeState;
use crate::ai::core::provider::protocol::{
    self, ReasoningSplitter, ToolCallAccumulator, append_tool_call_deltas, build_chat_request,
    extract_delta, finish_tool_calls, provider_from_request,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

fn event_name(run_id: &str) -> String {
    format!("ai://stream/{run_id}")
}

pub type AiEventSink = Arc<dyn Fn(&Value) + Send + Sync>;

use std::sync::Arc;

fn emit(
    app: &AppHandle,
    run_id: &str,
    payload: Value,
    sink: Option<&AiEventSink>,
) -> Result<(), String> {
    if let Some(sink) = sink {
        sink(&payload);
    }
    app.emit(&event_name(run_id), payload)
        .map_err(|error| format!("AI 流事件发送失败：{error}"))
}

fn request_text(request: &Value) -> Result<String, String> {
    let message = request
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if message.is_empty() {
        return Err("AI 请求内容不能为空".to_owned());
    }
    Ok(message.to_owned())
}

pub async fn stream_provider(
    app: AppHandle,
    runtime: AiRuntimeState,
    run_id: String,
    request: Value,
    sink: Option<AiEventSink>,
) -> Result<Value, String> {
    stream_provider_round(app, runtime, run_id, request, sink, true).await
}

/// W7b：`emit_done=false` 供 worker 多轮循环使用——中间轮不向前端发 done
/// （取消时仍照发 done(cancelled)），最终 done 由调用方统一发出。
pub async fn stream_provider_round(
    app: AppHandle,
    runtime: AiRuntimeState,
    run_id: String,
    request: Value,
    sink: Option<AiEventSink>,
    emit_done: bool,
) -> Result<Value, String> {
    let provider = provider_from_request(&request)?;
    let message = request_text(&request)?;
    let response = build_chat_request(&provider, &request, &message)?
        .send()
        .await
        .map_err(|_| "桌面端 AI 无法连接模型服务".to_owned())?;
    if !response.status().is_success() {
        return Err(
            protocol::provider_http_error(response, "桌面端 AI 模型请求失败").await,
        );
    }

    let meta = json!({ "provider": "tauri", "model": provider.model });
    emit(
        &app,
        &run_id,
        json!({ "type": "meta", "meta": meta.clone() }),
        sink.as_ref(),
    )?;
    let mut stream = response;
    let mut buffer = String::new();
    let mut text = String::new();
    let mut usage = Value::Null;
    let mut tool_calls = HashMap::<usize, ToolCallAccumulator>::new();
    // Qwen3/QwQ 系开放模型把思考流写进正文 <think> 标签：
    // 在协议层剥离为 reasoning 事件，正文只保留标签外的内容。
    let mut think_splitter = ReasoningSplitter::new();
    // W8：TTFT 实测（首轮内容/思考事件距请求发出的毫秒数），进最终 meta 供 trace 落库
    let round_started = std::time::Instant::now();
    let mut first_event_ms: Option<u64> = None;

    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|_| "桌面端 AI 流读取失败".to_owned())?
    {
        if runtime.is_cancelled(&run_id) {
            let payload = json!({ "text": text, "meta": meta, "cancelled": true });
            emit(
                &app,
                &run_id,
                json!({ "type": "done", "payload": payload }),
                sink.as_ref(),
            )?;
            return Ok(json!({ "cancelled": true }));
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].trim_end_matches('\r').to_owned();
            buffer.drain(..newline + 1);
            let data = line.strip_prefix("data:").map(str::trim).unwrap_or("");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let parsed: Value =
                serde_json::from_str(data).map_err(|_| "桌面端 AI 返回了无效流数据".to_owned())?;
            append_tool_call_deltas(&parsed, &mut tool_calls)?;
            if parsed.get("usage").is_some_and(|value| value.is_object()) {
                usage = parsed["usage"].clone();
            }
            if let Some((kind, delta)) = extract_delta(&parsed) {
                if first_event_ms.is_none() {
                    first_event_ms = Some(round_started.elapsed().as_millis() as u64);
                }
                if kind == "delta" {
                    let (content_part, reasoning_part) = think_splitter.split(delta);
                    if !reasoning_part.is_empty() {
                        emit(
                            &app,
                            &run_id,
                            json!({ "type": "reasoning", "text": reasoning_part }),
                            sink.as_ref(),
                        )?;
                    }
                    if !content_part.is_empty() {
                        text.push_str(&content_part);
                        emit(
                            &app,
                            &run_id,
                            json!({ "type": "delta", "text": content_part }),
                            sink.as_ref(),
                        )?;
                    }
                } else {
                    emit(
                        &app,
                        &run_id,
                        json!({ "type": kind, "text": delta }),
                        sink.as_ref(),
                    )?;
                }
            }
        }
    }

    // 流结束：冲刷 <think> 缓冲中可能残留的半个标签或未闭合的思考段
    let (rest_content, rest_reasoning) = think_splitter.finish();
    if !rest_reasoning.is_empty() {
        emit(
            &app,
            &run_id,
            json!({ "type": "reasoning", "text": rest_reasoning }),
            sink.as_ref(),
        )?;
    }
    if !rest_content.is_empty() {
        text.push_str(&rest_content);
        emit(
            &app,
            &run_id,
            json!({ "type": "delta", "text": rest_content }),
            sink.as_ref(),
        )?;
    }

    let mut final_meta = meta;
    if !usage.is_null() {
        final_meta["usage"] = usage;
    }
    if let Some(ttft) = first_event_ms {
        final_meta["ttftMs"] = json!(ttft);
    }
    let finished_tool_calls = finish_tool_calls(tool_calls)?;
    for call in &finished_tool_calls {
        emit(
            &app,
            &run_id,
            json!({ "type": "tool_call", "call": call, "payload": { "call": call } }),
            sink.as_ref(),
        )?;
    }
    let payload = json!({ "text": text, "meta": final_meta, "toolCalls": finished_tool_calls });
    if emit_done {
        emit(
            &app,
            &run_id,
            json!({ "type": "done", "payload": payload.clone() }),
            sink.as_ref(),
        )?;
    }
    Ok(payload)
}
