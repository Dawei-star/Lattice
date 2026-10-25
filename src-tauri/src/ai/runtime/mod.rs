//! AI runtime（地基 §4 `ai/runtime`，W4 自 `ai_runtime.rs` 拆分，行为零变化）。
//!
//! 分工：`chat` 流式编排（调用 core/provider 协议层）、`run_worker` run 生命周期、
//! `small_model` 轻量有界调用、`sanitize` 脱敏与检查点。
//! 协议解析在 `ai::core::provider`；本门面保持 `crate::ai::runtime::*` 稳定出口，
//! 顶层 `ai_runtime.rs` 再做一层历史路径门面（lib.rs 零改动）。

pub(crate) mod chat;
pub(crate) mod run_worker;
pub(crate) mod sanitize;
pub(crate) mod small_model;

pub use chat::{AiEventSink, stream_provider, stream_provider_round};
pub use run_worker::{AiRuntimeState, ai_chat_cancel, ai_chat_stream};
pub use sanitize::{
    checkpoint_for_tool_calls, redact_request_secrets, sanitize_ai_persistence,
    sanitize_tool_checkpoint,
};
pub use small_model::ai_small_model;

/// Test a configured provider from the desktop process. The key is read only
/// for this request; only status, latency and embedding dimension are returned.
/// 实现位于 `ai/core/provider/probe.rs`（W2）。
pub async fn ai_provider_test_runtime(request: serde_json::Value) -> Result<serde_json::Value, String> {
    crate::ai::core::provider::probe::run_provider_test(request).await
}
