//! AgentRunner 决策核心（地基 §5.5 `agent/runner`，W7a 纯逻辑，W7b 接线 durable run）。
//!
//! 只回答一个问题：**给定模型请求的一批工具调用，本轮应该怎么执行？**
//! 规则（行为契约照搬 web agent-tool-gateway 语义）：
//! - 读工具并行，单轮上限 `MAX_PARALLEL_READS`（4）；超出的顺延下一轮；
//! - 写工具串行；L2/L3 需要用户确认（挂起等待），已确认的直接放行；
//! - 未注册工具、预算耗尽、角色禁写一律拒绝并给出机器可读原因；
//! - 每个被接受的调用消耗 1 次工具预算。

use super::risk::{RiskLevel, WriteAction, classify_write_risk};
use super::ToolKind;
use super::ToolRegistry;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_PARALLEL_READS: usize = 4;

/// 模型请求的一次工具调用（id/name 来自协议层解析结果）。
#[derive(Debug, Clone)]
pub struct PendingCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WriteGate {
    /// L0/L1：直接执行
    Auto,
    /// L2/L3 且未确认：挂起等待用户确认
    NeedsConfirmation { level: RiskLevel, reason: String },
    /// 用户已确认：放行执行
    Granted,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedWrite {
    pub call: PendingCallShape,
    pub gate: WriteGate,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingCallShape {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RejectedCall {
    pub id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPlan {
    /// 本轮并行执行的读调用（≤4，保持请求顺序）
    pub reads: Vec<PendingCallShape>,
    /// 串行写调用（保持请求顺序，逐个过闸）
    pub writes: Vec<PlannedWrite>,
    /// 顺延到下一轮的读调用（超出并行上限）
    pub deferred_reads: Vec<PendingCallShape>,
    /// 被拒绝的调用与机器可读原因
    pub rejected: Vec<RejectedCall>,
    pub budget_exceeded: bool,
}

#[derive(Debug, Clone)]
pub struct RunnerInput<'a> {
    pub calls: &'a [PendingCall],
    /// 剩余可用工具调用次数；0 表示预算耗尽
    pub remaining_tool_calls: u32,
    /// viewer 角色为 false：一切写调用被拒绝
    pub writes_allowed: bool,
    /// 专家写策略允许 L2 免确认（`writePolicy: auto` 或会话审批选「跳过审批」）。L3 永不免。
    pub auto_approve_l2: bool,
    /// 用户选择「始终询问」：连 L1 草稿也挂起等确认（优先级高于 auto_approve_l2）。
    pub confirm_all_writes: bool,
    /// 用户显式确认过的高危豁免：L3（删除/外发/权限/批量）也不再询问。
    /// 默认 false；只有前端在「自动执行」档且用户开启开关时才会为 true。
    pub allow_irreversible: bool,
    /// 专家声明的写路径前缀黑名单（空表全放行）
    pub write_scope_exclude: &'a [String],
    /// 用户已确认的调用 id（resume 后回填）
    pub confirmations_granted: &'a HashSet<String>,
}

fn shape(call: &PendingCall) -> PendingCallShape {
    PendingCallShape {
        id: call.id.clone(),
        name: call.name.clone(),
    }
}

/// 决策核心：纯函数，不执行任何副作用（执行在 W7b 的 run worker 完成）。
pub fn plan_execution(registry: &ToolRegistry, input: &RunnerInput) -> ExecutionPlan {
    let mut plan = ExecutionPlan::default();
    let mut remaining = input.remaining_tool_calls;

    for call in input.calls {
        let Some(descriptor) = registry.get(&call.name) else {
            plan.rejected.push(RejectedCall {
                id: call.id.clone(),
                name: call.name.clone(),
                reason: "未注册的工具".to_owned(),
            });
            continue;
        };
        if remaining == 0 {
            plan.budget_exceeded = true;
            plan.rejected.push(RejectedCall {
                id: call.id.clone(),
                name: call.name.clone(),
                reason: "工具调用预算已耗尽".to_owned(),
            });
            continue;
        }

        match descriptor.kind {
            ToolKind::Read => {
                if plan.reads.len() < MAX_PARALLEL_READS {
                    plan.reads.push(shape(call));
                    remaining -= 1;
                } else {
                    plan.deferred_reads.push(shape(call));
                }
            }
            ToolKind::Write => {
                if !input.writes_allowed {
                    plan.rejected.push(RejectedCall {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        reason: "当前角色禁止写入".to_owned(),
                    });
                    continue;
                }
                if !write_within_scope(input.write_scope_exclude, call) {
                    plan.rejected.push(RejectedCall {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        reason: "超出专家允许的写入范围".to_owned(),
                    });
                    continue;
                }
                let assessment = classify_write_risk(&write_action_from(call));
                let gate = if input.confirmations_granted.contains(&call.id) {
                    WriteGate::Granted
                } else if input.confirm_all_writes {
                    // 「始终询问」不看风险等级：新建草稿也要先给用户看预览。
                    WriteGate::NeedsConfirmation {
                        level: assessment.level,
                        reason: assessment.reason.to_owned(),
                    }
                } else if assessment.requires_confirmation
                    && !(input.auto_approve_l2 && assessment.level == RiskLevel::L2)
                    && !(input.allow_irreversible && assessment.level == RiskLevel::L3)
                {
                    WriteGate::NeedsConfirmation {
                        level: assessment.level,
                        reason: assessment.reason.to_owned(),
                    }
                } else {
                    WriteGate::Auto
                };
                plan.writes.push(PlannedWrite {
                    call: shape(call),
                    gate,
                });
                remaining -= 1;
            }
        }
    }
    plan
}

/// 写调用路径是否在专家允许范围内（scopeExclude 前缀黑名单；空表全放行）。
/// 同时检查 `path` 与 `targetPath`（移动/复制的落点）。
fn write_within_scope(scope_exclude: &[String], call: &PendingCall) -> bool {
    if scope_exclude.is_empty() {
        return true;
    }
    let input = call.input.as_object();
    let path_allowed = |raw: Option<&str>| -> bool {
        let Some(raw) = raw else {
            return true;
        };
        let normalized = crate::ai::core::expert::normalize_scope_path(raw);
        if normalized.is_empty() {
            return true;
        }
        !scope_exclude
            .iter()
            .any(|prefix| normalized.starts_with(prefix.as_str()))
    };
    path_allowed(input.and_then(|object| object.get("path")).and_then(Value::as_str))
        && path_allowed(
            input
                .and_then(|object| object.get("targetPath"))
                .and_then(Value::as_str),
        )
}

fn write_action_from(call: &PendingCall) -> WriteAction<'_> {
    let input = call.input.as_object();
    let action_type = input
        .and_then(|object| object.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    WriteAction {
        action_type,
        external: input
            .and_then(|object| object.get("external"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        batch_size: input
            .and_then(|object| object.get("batchSize"))
            .and_then(Value::as_u64),
        ai_owned_draft: input
            .and_then(|object| object.get("aiOwnedDraft"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        target_exists: input
            .and_then(|object| object.get("targetExists"))
            .and_then(Value::as_bool),
    }
}

#[cfg(test)]
mod tests {
    use super::{ExecutionPlan, PendingCall, RunnerInput, WriteGate, MAX_PARALLEL_READS};
    use crate::ai::core::agent::risk::RiskLevel;
    use crate::ai::core::agent::ToolRegistry;
    use serde_json::{Value, json};
    use std::collections::HashSet;

    fn call(id: &str, name: &str, input: Value) -> PendingCall {
        PendingCall {
            id: id.to_owned(),
            name: name.to_owned(),
            input,
        }
    }

    fn run(calls: &[PendingCall], remaining: u32) -> ExecutionPlan {
        let registry = ToolRegistry::builtin();
        super::plan_execution(
            &registry,
            &RunnerInput {
                calls,
                remaining_tool_calls: remaining,
                writes_allowed: true,
                auto_approve_l2: false,
                confirm_all_writes: false,
                allow_irreversible: false,
                write_scope_exclude: &[],
                confirmations_granted: &HashSet::new(),
            },
        )
    }

    #[test]
    fn reads_batch_is_capped_and_extra_deferred() {
        let calls: Vec<PendingCall> = (0..6)
            .map(|index| call(&format!("r-{index}"), "lattice_file_read", json!({ "path": "a.md" })))
            .collect();
        let plan = run(&calls, 100);
        assert_eq!(plan.reads.len(), MAX_PARALLEL_READS);
        assert_eq!(plan.deferred_reads.len(), 2);
        assert_eq!(plan.deferred_reads[0].id, "r-4");
        assert!(plan.writes.is_empty());
        assert!(!plan.budget_exceeded);
    }

    #[test]
    fn writes_are_serialized_with_risk_gates() {
        let calls = vec![
            call("w-1", "lattice_file_operation", json!({ "type": "update", "path": "a.md" })),
            call("w-2", "lattice_file_operation", json!({ "type": "delete", "path": "b.md" })),
        ];
        let plan = run(&calls, 100);
        assert_eq!(plan.writes.len(), 2);
        assert_eq!(plan.writes[0].gate, WriteGate::NeedsConfirmation {
            level: RiskLevel::L2,
            reason: "会修改用户已有内容，需要预览差异".to_owned(),
        });
        assert_eq!(plan.writes[1].gate, WriteGate::NeedsConfirmation {
            level: RiskLevel::L3,
            reason: "删除、外发或权限变更影响不可逆".to_owned(),
        });
    }

    #[test]
    fn granted_confirmation_releases_gate_and_budget_rejects_overflow() {
        let calls = vec![call("w-1", "lattice_file_operation", json!({ "type": "update" }))];
        let registry = ToolRegistry::builtin();
        let granted: HashSet<String> = ["w-1".to_owned()].into_iter().collect();
        let plan = super::plan_execution(
            &registry,
            &RunnerInput {
                calls: &calls,
                remaining_tool_calls: 5,
                writes_allowed: true,
                auto_approve_l2: false,
                confirm_all_writes: false,
                allow_irreversible: false,
                write_scope_exclude: &[],
                confirmations_granted: &granted,
            },
        );
        assert_eq!(plan.writes[0].gate, WriteGate::Granted);

        // 预算耗尽：全部拒绝并标记
        let starved = run(&calls, 0);
        assert!(starved.budget_exceeded);
        assert_eq!(starved.rejected.len(), 1);
        assert_eq!(starved.rejected[0].reason, "工具调用预算已耗尽");
    }

    #[test]
    fn viewer_cannot_write_and_unknown_tools_are_rejected() {
        let registry = ToolRegistry::builtin();
        let calls = vec![
            call("w-1", "lattice_file_operation", json!({ "type": "update" })),
            call("x-1", "lattice_unknown_tool", json!({})),
        ];
        let plan = super::plan_execution(
            &registry,
            &RunnerInput {
                calls: &calls,
                remaining_tool_calls: 10,
                writes_allowed: false,
                auto_approve_l2: false,
                confirm_all_writes: false,
                allow_irreversible: false,
                write_scope_exclude: &[],
                confirmations_granted: &HashSet::new(),
            },
        );
        assert!(plan.writes.is_empty());
        assert_eq!(plan.rejected.len(), 2);
        assert_eq!(plan.rejected[0].reason, "当前角色禁止写入");
        assert_eq!(plan.rejected[1].reason, "未注册的工具");
    }

    #[test]
    fn expert_scope_rejects_out_of_range_writes() {
        let registry = ToolRegistry::builtin();
        let exclude = [".lattice/".to_owned(), "_templates/".to_owned()];
        let calls = vec![
            call("w-1", "lattice_file_operation", json!({ "type": "update", "path": ".lattice/experts/x.md" })),
            call("w-2", "lattice_file_operation", json!({ "type": "move", "path": "a.md", "targetPath": "_templates/a.md" })),
            call("w-3", "lattice_file_operation", json!({ "type": "update", "path": "notes/a.md" })),
        ];
        let plan = super::plan_execution(
            &registry,
            &RunnerInput {
                calls: &calls,
                remaining_tool_calls: 10,
                writes_allowed: true,
                auto_approve_l2: false,
                confirm_all_writes: false,
                allow_irreversible: false,
                write_scope_exclude: &exclude,
                confirmations_granted: &HashSet::new(),
            },
        );
        assert_eq!(plan.writes.len(), 1);
        assert_eq!(plan.writes[0].call.id, "w-3");
        assert_eq!(plan.rejected.len(), 2);
        assert!(plan.rejected.iter().all(|item| item.reason == "超出专家允许的写入范围"));
    }

    #[test]
    fn auto_policy_releases_l2_but_never_l3() {
        let registry = ToolRegistry::builtin();
        let calls = vec![
            call("w-1", "lattice_file_operation", json!({ "type": "update", "path": "a.md" })),
            call("w-2", "lattice_file_operation", json!({ "type": "delete", "path": "b.md" })),
            call("w-3", "lattice_file_operation", json!({ "type": "create", "path": "c.md" })),
        ];
        let plan = super::plan_execution(
            &registry,
            &RunnerInput {
                calls: &calls,
                remaining_tool_calls: 10,
                writes_allowed: true,
                auto_approve_l2: true,
                confirm_all_writes: false,
                allow_irreversible: false,
                write_scope_exclude: &[],
                confirmations_granted: &HashSet::new(),
            },
        );
        // L2（update）在 auto 策略下直执；L3（delete）仍需确认；L0（create）本来就直执
        assert_eq!(plan.writes[0].gate, WriteGate::Auto);
        assert!(matches!(
            plan.writes[1].gate,
            WriteGate::NeedsConfirmation { level: RiskLevel::L3, .. }
        ));
        assert_eq!(plan.writes[2].gate, WriteGate::Auto);
    }

    #[test]
    fn always_ask_gates_l1_and_overrides_auto_policy() {
        let registry = ToolRegistry::builtin();
        let calls = vec![
            call("w-1", "lattice_file_operation", json!({ "type": "create", "path": "draft.md" })),
            call("w-2", "lattice_file_operation", json!({ "type": "update", "path": "a.md" })),
        ];
        let plan = super::plan_execution(
            &registry,
            &RunnerInput {
                calls: &calls,
                remaining_tool_calls: 10,
                writes_allowed: true,
                auto_approve_l2: true,
                confirm_all_writes: true,
                allow_irreversible: false,
                write_scope_exclude: &[],
                confirmations_granted: &HashSet::new(),
            },
        );
        // 「始终询问」压过 auto 策略：L1 草稿与 L2 改动都必须先给用户看预览。
        assert!(matches!(
            plan.writes[0].gate,
            WriteGate::NeedsConfirmation { level: RiskLevel::L1, .. }
        ));
        assert!(matches!(
            plan.writes[1].gate,
            WriteGate::NeedsConfirmation { level: RiskLevel::L2, .. }
        ));
    }

    #[test]
    fn irreversible_opt_in_releases_l3_and_never_overrides_always_ask() {
        let registry = ToolRegistry::builtin();
        let calls = vec![
            call("w-1", "lattice_file_operation", json!({ "type": "update", "path": "a.md" })),
            call("w-2", "lattice_file_operation", json!({ "type": "delete", "path": "b.md" })),
        ];
        let granted_none: HashSet<String> = HashSet::new();
        let base = |allow_irreversible: bool, confirm_all_writes: bool| RunnerInput {
            calls: &calls,
            remaining_tool_calls: 10,
            writes_allowed: true,
            auto_approve_l2: true,
            confirm_all_writes,
            allow_irreversible,
            write_scope_exclude: &[],
            confirmations_granted: &granted_none,
        };

        // 默认：L2 直执，L3 仍要确认。
        let plan = super::plan_execution(&registry, &base(false, false));
        assert_eq!(plan.writes[0].gate, WriteGate::Auto);
        assert!(matches!(
            plan.writes[1].gate,
            WriteGate::NeedsConfirmation { level: RiskLevel::L3, .. }
        ));

        // 高危豁免开启：L3 也直执。
        let plan = super::plan_execution(&registry, &base(true, false));
        assert_eq!(plan.writes[1].gate, WriteGate::Auto);

        // 「始终询问」压过高危豁免：用户说了每次都要问，就是每次都要问。
        let plan = super::plan_execution(&registry, &base(true, true));
        assert!(matches!(
            plan.writes[1].gate,
            WriteGate::NeedsConfirmation { level: RiskLevel::L3, .. }
        ));
    }
}
