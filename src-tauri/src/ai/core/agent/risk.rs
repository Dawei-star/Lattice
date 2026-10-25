//! 写操作风险分级（地基 §5.5 `agent/risk`，W7a）。
//!
//! 与 web `classifyAiWriteRisk` 行为契约完全一致，由
//! `tests/fixtures/risk-classification.json` 双侧同断言钉死：
//! - L0：只读/非写操作（含未识别类型），自动执行；
//! - L1：新建或修改 AI 自己的草稿（可快照撤销），自动执行；
//! - L2：修改用户已有内容，需预览差异确认；
//! - L3：批量（>1）、删除/外发/权限变更或影响外部系统，必须确认且可能不可逆。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum RiskLevel {
    L0,
    L1,
    L2,
    L3,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskAssessment {
    pub level: RiskLevel,
    pub reversible: bool,
    pub requires_confirmation: bool,
    pub reason: &'static str,
}

/// 待评估的写动作（web `AiWriteAction` 的对齐子集）。
#[derive(Debug, Clone, Default)]
pub struct WriteAction<'a> {
    pub action_type: &'a str,
    pub external: bool,
    pub batch_size: Option<u64>,
    pub ai_owned_draft: bool,
    /// `None` 对应 web 的 `targetExists === undefined`。
    pub target_exists: Option<bool>,
}

const KNOWN_WRITE_TYPES: &[&str] = &[
    "create", "write", "update", "edit", "move", "copy", "archive", "delete", "remove", "purge",
    "send", "publish", "share", "permission", "permissions",
];
const DESTRUCTIVE_TYPES: &[&str] = &[
    "delete", "remove", "purge", "permission", "permissions", "send", "publish", "share",
];

pub fn classify_write_risk(action: &WriteAction) -> RiskAssessment {
    let action_type = action.action_type.to_ascii_lowercase();
    let batch_size = action.batch_size.unwrap_or(1).max(1);
    let external = action.external
        || matches!(
            action_type.as_str(),
            "send" | "publish" | "share" | "permission" | "permissions"
        );
    let destructive = DESTRUCTIVE_TYPES.contains(&action_type.as_str());

    if !KNOWN_WRITE_TYPES.contains(&action_type.as_str()) {
        return RiskAssessment {
            level: RiskLevel::L0,
            reversible: true,
            requires_confirmation: false,
            reason: "只读或非写操作",
        };
    }
    if external || destructive || batch_size > 1 {
        return RiskAssessment {
            level: RiskLevel::L3,
            reversible: !external && !destructive,
            requires_confirmation: true,
            reason: if external {
                "会影响外部系统或其他受众"
            } else if destructive {
                "删除、外发或权限变更影响不可逆"
            } else {
                "批量操作影响范围较大"
            },
        };
    }
    if action_type == "create" && (action.ai_owned_draft || action.target_exists != Some(true)) {
        return RiskAssessment {
            level: RiskLevel::L1,
            reversible: true,
            requires_confirmation: false,
            reason: "新建或修改 AI 自己的草稿，可通过快照撤销",
        };
    }
    RiskAssessment {
        level: RiskLevel::L2,
        reversible: true,
        requires_confirmation: true,
        reason: "会修改用户已有内容，需要预览差异",
    }
}

#[cfg(test)]
mod tests {
    use super::{RiskLevel, WriteAction, classify_write_risk};
    use serde_json::Value;

    /// 双侧共享夹具：与 web/test/ai-policy.test.mjs 读同一份 JSON，逐字段互证。
    #[test]
    fn risk_classification_matches_web_contract() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/risk-classification.json"
        );
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for case in fixture["cases"].as_array().expect("cases 数组") {
            let name = case["name"].as_str().unwrap_or("?");
            let raw = &case["action"];
            let action = WriteAction {
                action_type: raw["type"].as_str().unwrap_or(""),
                external: raw["external"].as_bool().unwrap_or(false),
                batch_size: raw["batchSize"]
                    .as_u64()
                    .or(case["batchSize"].as_u64()),
                ai_owned_draft: raw["aiOwnedDraft"].as_bool().unwrap_or(false),
                target_exists: raw["targetExists"].as_bool(),
            };
            let assessment = classify_write_risk(&action);
            let expected = &case["expected"];
            let level = match expected["level"].as_str().unwrap_or("L0") {
                "L1" => RiskLevel::L1,
                "L2" => RiskLevel::L2,
                "L3" => RiskLevel::L3,
                _ => RiskLevel::L0,
            };
            assert_eq!(assessment.level, level, "{name}: level 不一致");
            assert_eq!(
                assessment.reversible,
                expected["reversible"].as_bool().unwrap_or(true),
                "{name}: reversible 不一致"
            );
            assert_eq!(
                assessment.requires_confirmation,
                expected["requiresConfirmation"].as_bool().unwrap_or(false),
                "{name}: requiresConfirmation 不一致"
            );
            assert_eq!(
                assessment.reason,
                expected["reason"].as_str().unwrap_or(""),
                "{name}: reason 不一致"
            );
        }
    }
}
