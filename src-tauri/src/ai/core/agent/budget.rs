//! Agent 预算（地基 §5.5 `agent/budget`，W7a）。
//!
//! 与 web `buildAiAgentBudget` 同一双档默认（task / quick），
//! 并提供请求级覆盖的有界合并：任何覆盖只能收紧、不能放大默认上限。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBudget {
    pub max_steps: u32,
    pub max_tool_calls: u32,
    pub max_tokens: u64,
    pub max_duration_ms: u64,
}

pub const QUICK_BUDGET: AgentBudget = AgentBudget {
    max_steps: 4,
    max_tool_calls: 6,
    max_tokens: 6_000,
    max_duration_ms: 30_000,
};

pub const TASK_BUDGET: AgentBudget = AgentBudget {
    max_steps: 12,
    max_tool_calls: 24,
    max_tokens: 16_000,
    max_duration_ms: 120_000,
};

/// 预算上限（覆盖值只能收紧到 (0, mode_default] 区间内）。
pub fn budget_for_mode(mode: &str) -> AgentBudget {
    if mode == "task" {
        TASK_BUDGET
    } else {
        QUICK_BUDGET
    }
}

/// 请求级覆盖：字段存在才覆盖，且只能收紧不能放大。
pub fn budget_with_overrides(mode: &str, overrides: &serde_json::Value) -> AgentBudget {
    let base = budget_for_mode(mode);
    let clamp_u32 = |value: Option<&serde_json::Value>, ceiling: u32| -> u32 {
        value
            .and_then(serde_json::Value::as_u64)
            .map(|raw| raw.min(ceiling as u64) as u32)
            .unwrap_or(ceiling)
    };
    AgentBudget {
        max_steps: clamp_u32(overrides.get("maxSteps"), base.max_steps),
        max_tool_calls: clamp_u32(overrides.get("maxToolCalls"), base.max_tool_calls),
        max_tokens: overrides
            .get("maxTokens")
            .and_then(serde_json::Value::as_u64)
            .map(|raw| raw.min(base.max_tokens))
            .unwrap_or(base.max_tokens),
        max_duration_ms: overrides
            .get("maxDurationMs")
            .and_then(serde_json::Value::as_u64)
            .map(|raw| raw.min(base.max_duration_ms))
            .unwrap_or(base.max_duration_ms),
    }
}

#[cfg(test)]
mod tests {
    use super::{budget_for_mode, budget_with_overrides, QUICK_BUDGET, TASK_BUDGET};
    use serde_json::json;

    #[test]
    fn mode_budgets_match_web_defaults() {
        assert_eq!(budget_for_mode("task"), TASK_BUDGET);
        assert_eq!(budget_for_mode("quick"), QUICK_BUDGET);
        assert_eq!(budget_for_mode("anything-else"), QUICK_BUDGET);
        assert_eq!(TASK_BUDGET.max_steps, 12);
        assert_eq!(TASK_BUDGET.max_tool_calls, 24);
        assert_eq!(TASK_BUDGET.max_tokens, 16_000);
        assert_eq!(TASK_BUDGET.max_duration_ms, 120_000);
        assert_eq!(QUICK_BUDGET.max_steps, 4);
        assert_eq!(QUICK_BUDGET.max_tool_calls, 6);
    }

    #[test]
    fn overrides_only_tighten_never_expand() {
        let tightened = budget_with_overrides(
            "task",
            &json!({ "maxSteps": 30, "maxToolCalls": 3, "maxTokens": 2_000, "maxDurationMs": 5_000 }),
        );
        assert_eq!(tightened.max_steps, TASK_BUDGET.max_steps, "放大被钳制回默认");
        assert_eq!(tightened.max_tool_calls, 3);
        assert_eq!(tightened.max_tokens, 2_000);
        assert_eq!(tightened.max_duration_ms, 5_000);

        let untouched = budget_with_overrides("task", &json!({ "unknown": 1 }));
        assert_eq!(untouched, TASK_BUDGET);
    }
}
