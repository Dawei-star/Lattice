//! Agent 编排（地基 §5.5 `ai/core/agent`，W7a 立内核、W7b 接线）。
//!
//! W7a 交付：风险分级（risk，与 web 夹具互证）、预算（budget，只能收紧）、
//! 工具注册表（registry，声明式描述符）与 Runner 决策核心（runner，
//! 读并行 ≤4 / 写串行 / 确认门 / 预算闸的纯逻辑）。
//! W7b 把 Runner 接进 durable run worker、执行真实工具并退役 web 循环。

// W7b 接线前，本模块仅由契约测试构造（dead_code 为预期过渡状态）
#![allow(dead_code)]

pub(crate) mod budget;
pub(crate) mod risk;
pub(crate) mod runner;
pub(crate) mod tools;

// W7b 接线前仅契约测试消费这些出口（unused 为预期过渡状态）
#[allow(unused_imports)]
pub use budget::{AgentBudget, QUICK_BUDGET, TASK_BUDGET, budget_for_mode, budget_with_overrides};
#[allow(unused_imports)]
pub use risk::{RiskAssessment, RiskLevel, WriteAction, classify_write_risk};
#[allow(unused_imports)]
pub use runner::{
    ExecutionPlan, PendingCall, PlannedWrite, RejectedCall, RunnerInput, WriteGate, MAX_PARALLEL_READS,
    plan_execution,
};

use serde::Serialize;
use std::collections::BTreeMap;

/// 工具类别：读可并行（有界），写必须串行并过风险闸。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolKind {
    Read,
    Write,
}

/// 工具描述符（注册表条目）：新增工具 = 声明元数据 + 一处注册（地基 §9 扩展流程）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub kind: ToolKind,
    pub description: String,
    pub timeout_ms: u64,
    pub idempotent: bool,
}

impl ToolDescriptor {
    pub fn read(name: &str, description: &str) -> Self {
        Self {
            name: name.to_owned(),
            kind: ToolKind::Read,
            description: description.to_owned(),
            timeout_ms: 10_000,
            idempotent: true,
        }
    }

    pub fn write(name: &str, description: &str) -> Self {
        Self {
            name: name.to_owned(),
            kind: ToolKind::Write,
            description: description.to_owned(),
            timeout_ms: 30_000,
            idempotent: false,
        }
    }
}

/// 工具注册表：内置工具在启动时注册；MCP / 联网工具（W7b 后）运行时追加。
#[derive(Debug, Clone, Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, ToolDescriptor>,
}

impl ToolRegistry {
    /// 与现有 provider 工具面同名的内置集合（W7b：读工具可在内核执行，写走确认路径）。
    pub fn builtin() -> Self {
        let mut registry = Self::default();
        registry.register(ToolDescriptor::read("lattice_note_search", "按查询检索知识库分块"));
        registry.register(ToolDescriptor::read("lattice_file_grep", "在 Vault 内按正则检索"));
        registry.register(ToolDescriptor::read("lattice_file_read", "读取指定文件内容"));
        registry.register(ToolDescriptor::read("lattice_note_read", "读取指定笔记内容"));
        registry.register(ToolDescriptor::read("lattice_file_list", "列出范围内文件"));
        // E2 渐进披露的 L2：模型按目录里的 id 取技能全文（L0 只读、结果有界）。
        registry.register(ToolDescriptor::read(
            crate::ai::core::expert::SKILL_LOAD_TOOL,
            "加载指定技能的完整方法正文",
        ));
        registry.register(ToolDescriptor::write("lattice_file_operation", "创建/更新/移动/归档文件"));
        registry
    }

    pub fn register(&mut self, descriptor: ToolDescriptor) {
        self.tools.insert(descriptor.name.clone(), descriptor);
    }

    pub fn get(&self, name: &str) -> Option<&ToolDescriptor> {
        self.tools.get(name)
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::ToolKind;
    use super::ToolRegistry;

    #[test]
    fn builtin_registry_covers_current_tool_surface() {
        let registry = ToolRegistry::builtin();
        assert_eq!(registry.len(), 7);
        assert_eq!(registry.get("lattice_note_search").unwrap().kind, ToolKind::Read);
        assert_eq!(
            registry.get("lattice_file_operation").unwrap().kind,
            ToolKind::Write
        );
        assert_eq!(registry.get("skill_load").unwrap().kind, ToolKind::Read);
        assert!(registry.get("not-a-tool").is_none());
    }
}
