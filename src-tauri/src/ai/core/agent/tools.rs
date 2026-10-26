//! 工具执行（地基 §5.5）：Agent 循环下沉 worker 后，读/写工具都在内核直接执行。
//! 读结果与写结果均正文有界，输出形状与 web 网关对齐：`{callId, result}` 外层由
//! 调用方组装，此处返回 result；失败为 `{status:"failed", error}`，不中断整个 run。

use super::runner::PendingCall;
use crate::workspace::{FileAction, WorkspaceService};
use serde_json::{Value, json};

const MAX_RESULT_CHARS: usize = 4_000;
/// 内核写面：与 web `FILE_KERNEL_ACTIONS` 同集（archive 等非内核动作不走此通道）。
const WRITE_ACTION_TYPES: [&str; 5] = ["create", "update", "delete", "move", "copy"];

fn bounded_text(value: &str) -> String {
    value.chars().take(MAX_RESULT_CHARS).collect()
}

fn failed(error: String) -> Value {
    json!({ "status": "failed", "error": bounded_text(&error) })
}

/// 执行单个读工具调用。任何实现层错误都转为失败结果回填给模型，
/// 不中断整个 run（与 web 网关语义一致）。
pub fn execute_read_call(workspace: &WorkspaceService, call: &PendingCall) -> Value {
    let input = call.input.as_object();
    let string_field = |key: &str| -> Option<String> {
        input
            .and_then(|object| object.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    match call.name.as_str() {
        "lattice_file_read" | "lattice_note_read" => {
            let Some(path) = string_field("path") else {
                return failed("lattice_file_read 缺少 path".to_owned());
            };
            let offset = input
                .and_then(|object| object.get("offset"))
                .and_then(Value::as_u64);
            let limit = input
                .and_then(|object| object.get("limit"))
                .and_then(Value::as_u64);
            match workspace.file_read(&path, offset.unwrap_or(0), limit) {
                Ok(outcome) => serde_json::to_value(&outcome)
                    .map(|value| bounded_json(value))
                    .unwrap_or_else(|error| failed(error.to_string())),
                Err(error) => failed(error.message),
            }
        }
        "lattice_note_search" => {
            let Some(query) = string_field("query") else {
                return failed("lattice_note_search 缺少 query".to_owned());
            };
            let request = crate::ai::AiRetrievalRequest {
                query,
                queries: None,
                limit: input
                    .and_then(|object| object.get("limit"))
                    .and_then(Value::as_u64)
                    .map(|value| value as usize),
                folder_id: string_field("folderId"),
                inbox_status: string_field("inboxStatus"),
                allowed_paths: None,
                max_block_chars: None,
            };
            match crate::ai::retrieve(workspace.index(), request) {
                Ok(response) => {
                    let blocks: Vec<Value> = response
                        .blocks
                        .iter()
                        .map(|block| {
                            json!({
                                "title": block.title,
                                "path": block.path,
                                "anchor": block.anchor,
                                "excerpt": bounded_text(&block.excerpt),
                            })
                        })
                        .collect();
                    json!({ "status": "completed", "blocks": blocks })
                }
                Err(error) => failed(error),
            }
        }
        "lattice_file_grep" => {
            let Some(query) = string_field("query") else {
                return failed("lattice_file_grep 缺少 query".to_owned());
            };
            match workspace.file_grep(
                query,
                string_field("dir"),
                input
                    .and_then(|object| object.get("regex"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                string_field("fileType"),
            ) {
                Ok(outcome) => serde_json::to_value(&outcome)
                    .map(|value| bounded_json(value))
                    .unwrap_or_else(|error| failed(error.to_string())),
                Err(error) => failed(error.message),
            }
        }
        "lattice_file_list" => match workspace.file_find(
            string_field("pattern"),
            string_field("dir"),
            string_field("fileType"),
        ) {
            Ok(outcome) => serde_json::to_value(&outcome)
                .map(|value| bounded_json(value))
                .unwrap_or_else(|error| failed(error.to_string())),
            Err(error) => failed(error.message),
        },
        "skill_load" => {
            let Some(id) = string_field("id") else {
                return failed("skill_load 缺少 id".to_owned());
            };
            match workspace.skill_get(&id) {
                Ok(skill) => {
                    let content = skill
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if content.trim().is_empty() {
                        return failed(format!("技能「{id}」正文为空"));
                    }
                    let bounded: String = content
                        .chars()
                        .take(crate::ai::core::expert::SKILL_LOAD_MAX_CHARS)
                        .collect();
                    json!({
                        "status": "completed",
                        "id": id,
                        "title": skill.get("title").and_then(Value::as_str).unwrap_or(&id),
                        "content": bounded,
                        "truncated": content.chars().count() > bounded.chars().count(),
                    })
                }
                Err(error) => failed(error.message),
            }
        }
        other => failed(format!("未注册的读工具：{other}")),
    }
}

fn bounded_json(value: Value) -> Value {
    let serialized = value.to_string();
    if serialized.chars().count() <= MAX_RESULT_CHARS {
        return value;
    }
    json!({ "status": "completed", "truncated": true, "excerpt": bounded_text(&serialized) })
}

/// 模型工具调用 → 内核 FileAction（W7c 确认下沉）。
/// 与 web `actionsFromProviderToolCalls` + `toFileMutation` 同构：update 映射为内核
/// write 类型；类型/路径非法或属非内核动作时返回 None，由调用方按拒绝结果回填。
pub fn write_action_from_call(call: &PendingCall) -> Option<FileAction> {
    let input = call.input.as_object()?;
    let action_type = input.get("type")?.as_str()?.trim().to_lowercase();
    if !WRITE_ACTION_TYPES.contains(&action_type.as_str()) {
        return None;
    }
    let path = input.get("path").and_then(Value::as_str)?.trim().to_owned();
    if path.is_empty() {
        return None;
    }
    Some(FileAction {
        action_type: if action_type == "update" { "write".to_owned() } else { action_type },
        path,
        target_path: input.get("targetPath").and_then(Value::as_str).map(str::to_owned),
        content: input.get("content").and_then(Value::as_str).map(str::to_owned),
        replace: None,
        with: None,
        all: None,
    })
}

/// 执行单个写工具调用（L0/L1 Auto 闸由 runner 判定后走这里）：
/// 预览换取 planHash → 确认放行执行（审计/快照/undo 沿文件内核既有管线）。
/// 任何实现层错误都转为失败结果回填给模型，不中断整个 run。
pub fn execute_write_call(workspace: &WorkspaceService, call: &PendingCall, idempotency_key: &str) -> Value {
    let Some(action) = write_action_from_call(call) else {
        return failed("无效的写操作参数：type 须为 create/update/delete/move/copy 且 path 非空".to_owned());
    };
    let preview = match workspace.file_preview(Some(action.clone()), None) {
        Ok(preview) => preview,
        Err(error) => return failed(error.message),
    };
    let Some(plan_hash) = preview.get("planHash").and_then(Value::as_str).map(str::to_owned) else {
        return failed("写操作预览缺少 planHash".to_owned());
    };
    match workspace.file_execute_with_context(
        Some(action),
        None,
        true,
        false,
        None,
        Some(plan_hash),
        "local-user",
        "editor",
        None,
        Some(idempotency_key),
    ) {
        Ok(result) => bounded_json(result),
        Err(error) => failed(error.message),
    }
}

/// 为待确认写调用做单动作预览，返回执行所需的 planHash（W7c 挂起阶段）。
pub fn preview_write_call(workspace: &WorkspaceService, call: &PendingCall) -> Result<String, String> {
    let action = write_action_from_call(call)
        .ok_or_else(|| "无效的写操作参数：type 须为 create/update/delete/move/copy 且 path 非空".to_owned())?;
    let preview = workspace
        .file_preview(Some(action), None)
        .map_err(|error| error.message)?;
    preview
        .get("planHash")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "写操作预览缺少 planHash".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{PendingCall, execute_read_call, execute_write_call, preview_write_call, write_action_from_call};
    use serde_json::{Value, json};

    fn call(name: &str, input: Value) -> PendingCall {
        PendingCall {
            id: "call-1".to_owned(),
            name: name.to_owned(),
            input,
        }
    }

    #[test]
    fn write_action_mapping_matches_web_contract() {
        let update = write_action_from_call(&call(
            "lattice_file_operation",
            json!({ "type": "update", "path": "a.md", "content": "正文" }),
        ))
        .expect("update 应映射");
        assert_eq!(update.action_type, "write", "web toFileMutation 同构：update → write");
        assert_eq!(update.path, "a.md");
        assert_eq!(update.content.as_deref(), Some("正文"));

        assert!(write_action_from_call(&call(
            "lattice_file_operation",
            json!({ "type": "move", "path": "a.md", "targetPath": "b/b.md" }),
        ))
        .expect("move 应映射")
        .target_path
        .as_deref()
            == Some("b/b.md"));
        assert!(write_action_from_call(&call("lattice_file_operation", json!({ "type": "archive", "path": "a.md" }))).is_none());
        assert!(write_action_from_call(&call("lattice_file_operation", json!({ "type": "delete", "path": "" }))).is_none());
        assert!(write_action_from_call(&call("lattice_file_operation", json!({ "path": "a.md" }))).is_none());
    }

    #[test]
    fn write_execution_errors_become_failed_results() {
        let workspace = crate::workspace::WorkspaceService::open(
            std::env::temp_dir().join("lattice-agent-tools-write-test-vault"),
        );
        let Ok(workspace) = workspace else {
            return;
        };
        let invalid = execute_write_call(
            &workspace,
            &call("lattice_file_operation", json!({ "type": "archive", "path": "a.md" })),
            "run-1:call-1",
        );
        assert_eq!(invalid["status"], "failed");

        // 越出 Vault 的路径在预览闸即被拒
        let escape = execute_write_call(
            &workspace,
            &call("lattice_file_operation", json!({ "type": "create", "path": "../outside.md", "content": "x" })),
            "run-1:call-1",
        );
        assert_eq!(escape["status"], "failed");
        assert!(preview_write_call(&workspace, &call("lattice_file_operation", json!({ "type": "delete" }))).is_err());
    }

    #[test]
    fn unknown_and_missing_input_return_failed_results() {
        let workspace = crate::workspace::WorkspaceService::open(
            std::env::temp_dir().join("lattice-agent-tools-test-vault"),
        );
        let Ok(workspace) = workspace else {
            // 临时目录可能残留旧库（含历史笔记结构），本测试只验证错误路径，可跳过
            return;
        };
        let unknown = execute_read_call(&workspace, &call("lattice_unknown", json!({})));
        assert_eq!(unknown["status"], "failed");
        assert!(unknown["error"].as_str().unwrap().contains("未注册"));

        let missing = execute_read_call(&workspace, &call("lattice_file_read", json!({})));
        assert_eq!(missing["status"], "failed");
        assert!(missing["error"].as_str().unwrap().contains("path"));

        let absent = execute_read_call(
            &workspace,
            &call("lattice_file_read", json!({ "path": "不存在的笔记.md" })),
        );
        assert_eq!(absent["status"], "failed");
    }
}
