//! 历史路径门面（W4）：实现已拆分至 `ai::runtime::*` 与 `ai::core::provider`，
//! 本文件只保留 `ai_runtime::*` 的既有导入路径，lib.rs 与外部调用点零改动。

// 门面保持完整历史出口（stream_provider 等由外部测试/后续批次消费）
#[allow(unused_imports)]
pub use crate::ai::runtime::{
    AiEventSink, AiRuntimeState, ai_chat_cancel, ai_chat_stream, ai_provider_test_runtime,
    ai_small_model, checkpoint_for_tool_calls, redact_request_secrets, sanitize_ai_persistence,
    sanitize_tool_checkpoint, stream_provider, stream_provider_round,
};
