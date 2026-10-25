//! Provider 层（地基方案 §5.1）：协议适配 + 连通性探测。
//!
//! W2 把 OpenAI 兼容协议（请求组装 / SSE 解析 / 工具增量累积 / reasoning 归一）
//! 从 `ai_runtime.rs` 迁入此处；runtime 只保留 run 生命周期并调用本层。
//! 上层永远只消费归一化结果（delta / reasoning / tool_call / done），
//! 协议差异封死在 `protocol` 模块内，新增协议 = 新增一个协议子模块。

pub(crate) mod capabilities;
pub(crate) mod catalog;
pub(crate) mod discovery;
pub(crate) mod probe;
pub(crate) mod protocol;
