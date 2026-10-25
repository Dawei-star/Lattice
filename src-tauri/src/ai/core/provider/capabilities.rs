//! 模型能力声明（地基方案 §5.1）：开放模型差异极大（工具调用有无、思考流格式、
//! 上下文 32k–1M），每次请求前显式协商，而不是默认所有模型都长成 gpt-4o。
//!
//! 能力协商链：目录声明（W3，本文件）→ `/v1/models` 发现补充（W3）→
//! probe 实测（W7）→ trace 观测回写（W8）。

use serde::{Deserialize, Serialize};

/// 思考流的归一形态（协议层负责把各种上游格式归一成 Reasoning 事件）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReasoningKind {
    /// 不输出思考流
    #[default]
    #[serde(rename = "none")]
    None,
    /// DeepSeek 系：`delta.reasoning_content` 独立通道
    ReasoningContent,
    /// Qwen3/QwQ 系：正文内嵌 `<think>` 标签（openai Adapter 剥离）
    ThinkTags,
}

/// 单模型能力与出处声明。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCapabilities {
    pub(crate) context_window_tokens: u32,
    /// false → 任务模式降级（禁用工具并提示，而非静默失败；W7 接 UI）
    #[serde(default)]
    pub(crate) native_tools: bool,
    #[serde(default)]
    pub(crate) vision: bool,
    #[serde(default)]
    pub(crate) reasoning: ReasoningKind,
    /// UI 徽标：开放权重（GitHub/HuggingFace 可得权重）
    #[serde(default)]
    pub(crate) open_weights: bool,
    /// 1k token 单价（美元）；本机推理恒为 None（零成本）
    #[serde(default)]
    pub(crate) prompt_cost_per_1k_usd: Option<f64>,
    #[serde(default)]
    pub(crate) completion_cost_per_1k_usd: Option<f64>,
}
