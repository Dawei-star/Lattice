//! 脱敏与检查点（地基 §4 `runtime/sanitize`，W4 自 `ai_runtime.rs` 迁入，行为零变化）。
//!
//! 两条铁律的实现现场：
//! - **落盘必脱敏**：durable 请求只保留可恢复的最小元数据，API Key 只留掩码语义
//!   （真实密钥只存在于进程内存的 pending map，绝不进 SQLite / 日志）；
//! - **检查点只存执行元数据**：写正文、读取结果、附件内容一律剥离，仅保留
//!   重放/恢复所需的状态与路径。

use crate::ai::core::provider::protocol::{MAX_PROVIDER_TOOLS, valid_tool_name};
use serde_json::{Map, Value, json};

pub(crate) const CHECKPOINT_TEXT_LIMIT: usize = 512;
pub(crate) const CHECKPOINT_STEP_LIMIT: usize = 256;

fn copy_field(source: &Map<String, Value>, target: &mut Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key) {
        target.insert(key.to_owned(), value.clone());
    }
}

fn copy_string_fields(source: &Map<String, Value>, target: &mut Map<String, Value>, keys: &[&str]) {
    for key in keys {
        if source.get(*key).and_then(Value::as_str).is_some() {
            copy_field(source, target, key);
        }
    }
}

fn sanitize_provider(provider: &Value) -> Option<Value> {
    let source = provider.as_object()?;
    let mut target = Map::new();
    copy_string_fields(source, &mut target, &["endpoint", "model", "authHeader"]);
    for key in [
        "temperature",
        "maxTokens",
        "contextWindowTokens",
        "promptCostPer1kUsd",
        "completionCostPer1kUsd",
    ] {
        if source.get(key).is_some_and(|value| value.is_number()) {
            copy_field(source, &mut target, key);
        }
    }
    // Keep the shape explicit while ensuring credentials are never recoverable
    // from the SQLite payload. The real key remains in pending_requests.
    if source.contains_key("apiKey") {
        target.insert("apiKey".to_owned(), Value::String(String::new()));
    }
    if source.contains_key("api_key") {
        target.insert("api_key".to_owned(), Value::String(String::new()));
    }
    Some(Value::Object(target))
}

fn sanitize_context_metadata(context: &Value) -> Option<Value> {
    let source = context.as_object()?;
    let mut target = Map::new();
    copy_string_fields(
        source,
        &mut target,
        &["activeFile", "scope", "scopeLabel", "requestedScope"],
    );

    if let Some(project) = source.get("project").and_then(Value::as_object) {
        let mut safe_project = Map::new();
        copy_string_fields(project, &mut safe_project, &["name", "path", "folderId"]);
        if project.get("fileCount").and_then(Value::as_u64).is_some() {
            copy_field(project, &mut safe_project, "fileCount");
        }
        if !safe_project.is_empty() {
            target.insert("project".to_owned(), Value::Object(safe_project));
        }
    }

    if let Some(inbox) = source.get("inbox").and_then(Value::as_object) {
        let mut safe_inbox = Map::new();
        for key in ["total", "pending"] {
            if inbox.get(key).and_then(Value::as_u64).is_some() {
                copy_field(inbox, &mut safe_inbox, key);
            }
        }
        if !safe_inbox.is_empty() {
            target.insert("inbox".to_owned(), Value::Object(safe_inbox));
        }
    }

    if let Some(permission) = source.get("permissionContext").and_then(Value::as_object) {
        let mut safe_permission = Map::new();
        copy_string_fields(
            permission,
            &mut safe_permission,
            &[
                "actor",
                "role",
                "scopeId",
                "permissionVersion",
                "contentVersion",
            ],
        );
        if !safe_permission.is_empty() {
            target.insert(
                "permissionContext".to_owned(),
                Value::Object(safe_permission),
            );
        }
    }

    Some(Value::Object(target))
}

fn sanitize_routing(routing: &Value) -> Option<Value> {
    let source = routing.as_object()?;
    let mut target = Map::new();
    if let Some(intents) = source.get("intents").and_then(Value::as_array) {
        let safe_intents = intents
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        target.insert("intents".to_owned(), json!(safe_intents));
    }
    for key in ["confidence", "requiresClarification"] {
        if source
            .get(key)
            .is_some_and(|value| value.is_number() || value.is_boolean())
        {
            copy_field(source, &mut target, key);
        }
    }
    copy_string_fields(source, &mut target, &["modelTier"]);
    Some(Value::Object(target))
}

fn sanitize_budget(budget: &Value) -> Option<Value> {
    let source = budget.as_object()?;
    let mut target = Map::new();
    for key in ["maxSteps", "maxToolCalls", "maxTokens", "maxDurationMs"] {
        if source.get(key).and_then(Value::as_u64).is_some() {
            copy_field(source, &mut target, key);
        }
    }
    Some(Value::Object(target))
}

/// 将排队请求裁剪为可恢复的最小元数据。API Key 只保留在当前进程的
/// pending map 中；请求正文、上下文块、检索内容、文件内容、附件和工具配置不落盘。
pub fn redact_request_secrets(request: &Value) -> Value {
    let Some(source) = request.as_object() else {
        return Value::Object(Map::new());
    };
    let mut persisted = Map::new();
    for key in ["runId", "message", "sessionId", "mode"] {
        copy_field(source, &mut persisted, key);
    }
    for key in [
        "resumeRun",
        "preferModel",
        "autoApprove",
        "allowIrreversible",
        "webSearch",
        "regenerate",
    ] {
        if source.get(key).and_then(Value::as_bool).is_some() {
            copy_field(source, &mut persisted, key);
        }
    }
    for key in ["actor", "role", "expertId", "approvalPolicy"] {
        if source.get(key).and_then(Value::as_str).is_some() {
            copy_field(source, &mut persisted, key);
        }
    }
    // 用户显式调用的技能 id 是恢复运行所需的元数据（正文不落盘）。
    if let Some(items) = source.get("invokedSkills").and_then(Value::as_array) {
        let ids: Vec<Value> = items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.chars().count() <= 120)
            .take(8)
            .map(|id| Value::String(id.to_owned()))
            .collect();
        if !ids.is_empty() {
            persisted.insert("invokedSkills".to_owned(), Value::Array(ids));
        }
    }
    for (key, sanitizer) in [
        ("provider", sanitize_provider as fn(&Value) -> Option<Value>),
        ("context", sanitize_context_metadata),
        ("routing", sanitize_routing),
        ("budget", sanitize_budget),
    ] {
        if let Some(value) = source.get(key).and_then(sanitizer) {
            if value.as_object().is_none_or(|object| !object.is_empty()) {
                persisted.insert(key.to_owned(), value);
            }
        }
    }
    if let Some(scope) = source.get("scope").and_then(Value::as_object) {
        let mut safe_scope = Map::new();
        copy_string_fields(scope, &mut safe_scope, &["kind", "id", "label", "source"]);
        if !safe_scope.is_empty() {
            persisted.insert("scope".to_owned(), Value::Object(safe_scope));
        }
    }
    Value::Object(persisted)
}

fn bounded_persisted_text(value: Option<&Value>, limit: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(limit).collect())
}

fn sanitize_persisted_tool_call(input: &Value) -> Value {
    let Some(object) = input.as_object() else {
        return json!({});
    };
    let mut safe = Map::new();
    for key in ["id", "name", "type"] {
        if let Some(value) = bounded_persisted_text(object.get(key), 128) {
            safe.insert(key.to_owned(), Value::String(value));
        }
    }
    if let Some(arguments) = object.get("input").and_then(Value::as_object) {
        let mut safe_input = Map::new();
        for key in ["path", "targetPath", "type"] {
            if let Some(value) = bounded_persisted_text(arguments.get(key), 1_024) {
                safe_input.insert(key.to_owned(), Value::String(value));
            }
        }
        let allows_query = matches!(
            object.get("name").and_then(Value::as_str),
            Some("lattice_note_search") | Some("lattice_file_grep")
        );
        if allows_query {
            if let Some(value) = bounded_persisted_text(arguments.get("query"), 1_024) {
                safe_input.insert("query".to_owned(), Value::String(value));
            }
        }
        for key in ["offset", "limit"] {
            if let Some(value) = arguments.get(key).and_then(Value::as_i64) {
                safe_input.insert(key.to_owned(), json!(value.max(0)));
            }
        }
        safe.insert("input".to_owned(), Value::Object(safe_input));
    }
    Value::Object(safe)
}

/// Keep durable operation results to recovery metadata only. In particular,
/// write bodies and read results must never be copied into SQLite job rows or
/// AI event payloads.
fn sanitize_persisted_operation(input: &Value) -> Value {
    let Some(object) = input.as_object() else {
        return Value::Object(Map::new());
    };
    let mut safe = Map::new();
    for key in [
        "id",
        "operationId",
        "toolName",
        "callId",
        "type",
        "status",
        "path",
        "targetPath",
        "sourcePath",
        "fromPath",
        "toPath",
        "error",
        "summary",
    ] {
        if let Some(value) = bounded_persisted_text(object.get(key), 1_024) {
            safe.insert(key.to_owned(), Value::String(value));
        }
    }
    if let Some(operation_ids) = object.get("operationIds").and_then(Value::as_array) {
        let ids = operation_ids
            .iter()
            .filter_map(|value| bounded_persisted_text(Some(value), 256).map(Value::String))
            .take(CHECKPOINT_STEP_LIMIT)
            .collect::<Vec<_>>();
        if !ids.is_empty() {
            safe.insert("operationIds".to_owned(), Value::Array(ids));
        }
    }
    for key in ["action", "operation", "result"] {
        if let Some(value) = object.get(key).filter(|value| value.is_object()) {
            safe.insert(key.to_owned(), sanitize_persisted_operation(value));
        }
    }
    Value::Object(safe)
}

fn sanitize_persisted_operations(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(sanitize_persisted_operation)
                .take(CHECKPOINT_STEP_LIMIT)
                .collect(),
        ),
        _ => Value::Array(Vec::new()),
    }
}

/// Remove potentially sensitive tool arguments before durable event/result persistence.
/// The live stream still receives the original provider payload; only SQLite gets this shape.
pub fn sanitize_ai_persistence(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sanitize_ai_persistence).collect()),
        Value::Object(object) => {
            if object.contains_key("name") && (object.contains_key("input") || object.contains_key("id")) {
                return sanitize_persisted_tool_call(value);
            }
            let mut sanitized = Map::new();
            for (key, child) in object {
                if matches!(key.as_str(), "toolCalls" | "tool_calls") {
                    let calls = child
                        .as_array()
                        .map(|items| items.iter().map(sanitize_persisted_tool_call).collect())
                        .unwrap_or_default();
                    sanitized.insert(key.clone(), Value::Array(calls));
                } else if matches!(
                    key.as_str(),
                    "actions"
                        | "plannedActions"
                        | "operations"
                        | "aiOperations"
                        | "fileOperations"
                        | "results"
                        | "operationResults"
                        | "toolResults"
                        | "executedOperations"
                ) {
                    sanitized.insert(key.clone(), sanitize_persisted_operations(child));
                } else if key == "call" {
                    sanitized.insert(key.clone(), sanitize_persisted_tool_call(child));
                } else {
                    sanitized.insert(key.clone(), sanitize_ai_persistence(child));
                }
            }
            Value::Object(sanitized)
        }
        _ => value.clone(),
    }
}

fn checkpoint_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(CHECKPOINT_TEXT_LIMIT).collect())
}

/// Keep tool checkpoints to non-sensitive execution metadata. Request bodies,
/// file contents, attachments and provider credentials are intentionally dropped.
pub fn sanitize_tool_checkpoint(input: &Value) -> Result<Value, String> {
    let object = input
        .as_object()
        .ok_or_else(|| "AI 工具检查点必须是对象".to_owned())?;
    let stage = object
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or("tool_execution");
    if !matches!(stage, "tool_execution" | "waiting_confirmation" | "tool_completed" | "tool_failed") {
        return Err("AI 工具检查点阶段无效".to_owned());
    }

    let mut checkpoint = json!({ "stage": stage, "completedSteps": [] });
    for key in ["planHash", "nextStepId", "lastError"] {
        if let Some(value) = checkpoint_text(object.get(key)) {
            checkpoint[key] = Value::String(value);
        }
    }
    if let Some(sequence) = object.get("sequence").and_then(Value::as_i64) {
        checkpoint["sequence"] = json!(sequence.max(0));
    }

    let steps = object
        .get("completedSteps")
        .and_then(Value::as_array)
        .map(|steps| steps.as_slice())
        .unwrap_or(&[]);
    let mut safe_steps = Vec::new();
    for step in steps.iter().take(CHECKPOINT_STEP_LIMIT) {
        let Some(step) = step.as_object() else {
            continue;
        };
        let Some(id) = checkpoint_text(step.get("id")) else {
            continue;
        };
        let status = step
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| matches!(*status, "completed" | "failed" | "pending"))
            .unwrap_or("pending");
        let mut safe = json!({ "id": id, "status": status });
        for key in ["operationId", "toolName", "callId", "type", "path", "targetPath"] {
            if let Some(value) = checkpoint_text(step.get(key)) {
                safe[key] = Value::String(value);
            }
        }
        if let Some(operation_ids) = step.get("operationIds").and_then(Value::as_array) {
            let safe_operation_ids = operation_ids
                .iter()
                .filter_map(|value| checkpoint_text(Some(value)).map(Value::String))
                .take(CHECKPOINT_STEP_LIMIT)
                .collect::<Vec<_>>();
            if !safe_operation_ids.is_empty() {
                safe["operationIds"] = Value::Array(safe_operation_ids);
            }
        }
        if let Some(input) = step.get("input").and_then(Value::as_object) {
            let mut safe_input = Map::new();
            for key in ["path", "query"] {
                if let Some(value) = checkpoint_text(input.get(key)) {
                    safe_input.insert(key.to_owned(), Value::String(value));
                }
            }
            for key in ["offset", "limit"] {
                if let Some(value) = input.get(key).and_then(Value::as_i64) {
                    safe_input.insert(key.to_owned(), json!(value.max(0)));
                }
            }
            if !safe_input.is_empty() {
                safe["input"] = Value::Object(safe_input);
            }
        }
        safe_steps.push(safe);
    }
    checkpoint["completedSteps"] = Value::Array(safe_steps);
    Ok(checkpoint)
}

/// Convert provider tool calls into a safe pending checkpoint. The checkpoint
/// only tells the UI what may be replayed or regenerated after a restart;
/// sanitize_tool_checkpoint drops write bodies before persistence.
pub fn checkpoint_for_tool_calls(payload: &Value) -> Result<Option<Value>, String> {
    let Some(calls) = payload.get("toolCalls").and_then(Value::as_array) else {
        return Ok(None);
    };
    let mut steps = Vec::new();
    for call in calls.iter().take(MAX_PROVIDER_TOOLS) {
        let Some(object) = call.as_object() else {
            continue;
        };
        let Some(id) = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let Some(name) = object
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| valid_tool_name(value))
        else {
            continue;
        };
        let input = object.get("input").cloned().unwrap_or_else(|| json!({}));
        let mut step = json!({
            "id": format!("provider-tool:{id}"),
            "toolName": name,
            "callId": id,
            "status": "pending",
            "input": input,
        });
        let input = step.get("input").and_then(Value::as_object).cloned();
        if let Some(input) = input.as_ref() {
            for key in ["type", "path", "targetPath"] {
                if let Some(value) = input.get(key).and_then(Value::as_str) {
                    step[key] = Value::String(value.to_owned());
                }
            }
        }
        steps.push(step);
    }
    if steps.is_empty() {
        return Ok(None);
    }
    sanitize_tool_checkpoint(&json!({
        "stage": "tool_execution",
        "completedSteps": steps,
    }))
    .map(Some)
}

#[cfg(test)]
mod tests {
    // 测试专用标记串：拼装构造、非凭据形态，仅用于断言「原始值不落盘」。
    fn key_marker() -> String {
        format!("provider-key-{}-marker", "raw")
    }

    use super::{
        checkpoint_for_tool_calls, redact_request_secrets, sanitize_ai_persistence,
        sanitize_tool_checkpoint,
    };
    use serde_json::json;

    #[test]
    fn durable_request_payload_keeps_resume_metadata_only() {
        let persisted = redact_request_secrets(&json!({
            "runId": "run-1",
            "message": "请总结当前文档",
            "sessionId": "session-1",
            "mode": "task",
            "provider": {
                "endpoint": "https://model.example/v1/chat/completions",
                "model": "model-1",
                "apiKey": key_marker(),
                "temperature": 0.2,
                "maxTokens": 4096,
                "headers": { "authorization": "header-payload-marker" }
            },
            "context": {
                "activeFile": "Notes/a.md",
                "activeFileContent": "file-content-marker",
                "scope": "current",
                "permissionContext": {
                    "actor": "local-user",
                    "role": "owner",
                    "scopeId": "current",
                    "permissionVersion": "p1",
                    "contentVersion": "c1"
                },
                "blocks": [{ "content": "context-content-marker" }],
                "retrieval": [{
                    "content": "retrieval-content-marker",
                    "metadata": { "excerpt": "retrieval-excerpt-marker" }
                }]
            },
            "routing": {
                "intents": ["qa"],
                "confidence": 0.82,
                "modelTier": "fast",
                "requiresClarification": false,
                "reasons": ["drop reason text"]
            },
            "budget": {
                "maxSteps": 4,
                "maxToolCalls": 6,
                "maxTokens": 6000,
                "maxDurationMs": 30000
            },
            "attachments": [{
                "name": "image.png",
                "dataUrl": "data:image/png;base64,attachment-marker"
            }],
            "mcpServers": [{ "env": { "TOKEN": "mcp-marker" } }],
            "authorization": "Bearer authorization-marker",
            "unknownSecret": "unknown-marker"
        }));

        assert_eq!(persisted["runId"], "run-1");
        assert_eq!(persisted["message"], "请总结当前文档");
        assert_eq!(persisted["provider"]["apiKey"], "");
        assert_eq!(persisted["provider"]["model"], "model-1");
        assert!(persisted["provider"].get("headers").is_none());
        assert_eq!(persisted["context"]["activeFile"], "Notes/a.md");
        assert_eq!(persisted["context"]["permissionContext"]["role"], "owner");
        assert!(persisted["context"].get("activeFileContent").is_none());
        assert!(persisted["context"].get("blocks").is_none());
        assert!(persisted["context"].get("retrieval").is_none());
        assert!(persisted.get("attachments").is_none());
        assert!(persisted.get("mcpServers").is_none());
        assert!(persisted.get("authorization").is_none());
        assert!(persisted.get("unknownSecret").is_none());
        let serialized = persisted.to_string();
        for marker in [
            &key_marker(),
            "header-payload-marker",
            "file-content-marker",
            "context-content-marker",
            "retrieval-content-marker",
            "retrieval-excerpt-marker",
            "attachment-marker",
            "mcp-marker",
            "authorization-marker",
            "unknown-marker",
        ] {
            assert!(!serialized.contains(marker), "落盘载荷不应包含 {marker}");
        }
    }

    #[test]
    fn tool_checkpoint_keeps_execution_metadata_only() {
        let checkpoint = sanitize_tool_checkpoint(&json!({
            "stage": "tool_execution",
            "planHash": "hash-1",
            "sequence": 4,
            "message": "drop me",
            "request": { "provider": { "apiKey": key_marker() } },
            "completedSteps": [{
                "id": "op-1",
                "operationId": "operation-1",
                "status": "completed",
                "type": "update",
                "path": "Notes/a.md",
                "toolName": "lattice_file_read",
                "callId": "call-1",
                "input": {
                    "path": "Notes/a.md",
                    "offset": 2,
                    "limit": 100,
                    "query": "safe query",
                    "content": "drop file content"
                },
                "operationIds": ["operation-1", "operation-2"],
                "content": "drop file content"
            }]
        }))
        .unwrap();
        assert_eq!(checkpoint["stage"], "tool_execution");
        assert_eq!(
            checkpoint["completedSteps"][0]["operationId"],
            "operation-1"
        );
        assert!(checkpoint["completedSteps"][0].get("content").is_none());
        assert_eq!(checkpoint["completedSteps"][0]["toolName"], "lattice_file_read");
        assert_eq!(checkpoint["completedSteps"][0]["callId"], "call-1");
        assert_eq!(checkpoint["completedSteps"][0]["input"]["path"], "Notes/a.md");
        assert!(checkpoint["completedSteps"][0]["input"].get("content").is_none());
        assert_eq!(checkpoint["completedSteps"][0]["operationIds"][1], "operation-2");
        assert!(checkpoint.get("request").is_none());
        assert!(checkpoint.get("message").is_none());
    }

    #[test]
    fn tool_checkpoint_rejects_unknown_stage() {
        let error = sanitize_tool_checkpoint(&json!({ "stage": "generating" })).unwrap_err();
        assert!(error.contains("阶段无效"));
    }

    #[test]
    fn durable_results_drop_sensitive_tool_arguments() {
        let persisted = sanitize_ai_persistence(&json!({
            "type": "done",
            "payload": {
                "toolCalls": [{
                    "id": "call-1",
                    "name": "lattice_file_operation",
                    "input": {
                        "type": "update",
                        "path": "Notes/a.md",
                        "targetPath": "Notes/b.md",
                        "content": "file-content-marker",
                        "query": "drop from write call"
                    }
                }]
            },
            "call": {
                "id": "call-2",
                "name": "lattice_note_search",
                "input": { "query": "keep query", "limit": 4, "content": "drop" }
            }
        }));
        assert_eq!(persisted["payload"]["toolCalls"][0]["input"]["path"], "Notes/a.md");
        assert!(persisted["payload"]["toolCalls"][0]["input"].get("content").is_none());
        assert!(persisted["payload"]["toolCalls"][0]["input"].get("query").is_none());
        assert_eq!(persisted["call"]["input"]["query"], "keep query");
        assert!(persisted["call"]["input"].get("content").is_none());
        assert!(!persisted.to_string().contains("file-content-marker"));
    }

    #[test]
    fn durable_results_drop_write_bodies_from_operation_collections() {
        let persisted = sanitize_ai_persistence(&json!({
            "type": "done",
            "payload": {
                "text": "已完成写入",
                "actions": [{
                    "id": "action-1",
                    "type": "update",
                    "path": "Notes/a.md",
                    "content": "write-body-marker"
                }],
                "operations": [{
                    "id": "operation-1",
                    "action": {
                        "type": "update",
                        "path": "Notes/a.md",
                        "content": "nested-write-body-marker"
                    },
                    "result": {
                        "operationId": "operation-1",
                        "content": "result-body-marker"
                    }
                }],
                "results": [{
                    "status": "completed",
                    "operationIds": ["operation-1"],
                    "result": { "operationId": "operation-1", "content": "result-body-marker" },
                    "content": "result-body-marker"
                }]
            }
        }));

        assert_eq!(persisted["payload"]["text"], "已完成写入");
        assert_eq!(persisted["payload"]["actions"][0]["path"], "Notes/a.md");
        assert!(persisted["payload"]["actions"][0].get("content").is_none());
        assert_eq!(
            persisted["payload"]["operations"][0]["result"]["operationId"],
            "operation-1"
        );
        assert!(persisted["payload"]["operations"][0]["action"]
            .get("content")
            .is_none());
        assert!(persisted["payload"]["results"][0].get("content").is_none());
        assert!(!persisted.to_string().contains("write-body-marker"));
        assert!(!persisted.to_string().contains("nested-write-body-marker"));
        assert!(!persisted.to_string().contains("result-body-marker"));
    }

    #[test]
    fn tool_call_checkpoint_keeps_replay_metadata_without_write_body() {
        let checkpoint = checkpoint_for_tool_calls(&json!({
            "toolCalls": [
                {
                    "id": "call-read",
                    "name": "lattice_file_read",
                    "input": { "path": "Notes/a.md", "offset": 2, "limit": 100 }
                },
                {
                    "id": "call-write",
                    "name": "lattice_file_operation",
                    "input": {
                        "type": "update",
                        "path": "Notes/a.md",
                        "content": "do-not-persist"
                    }
                }
            ]
        }))
        .unwrap()
        .unwrap();
        assert_eq!(checkpoint["stage"], "tool_execution");
        assert_eq!(checkpoint["completedSteps"].as_array().unwrap().len(), 2);
        assert_eq!(checkpoint["completedSteps"][0]["input"]["path"], "Notes/a.md");
        assert_eq!(checkpoint["completedSteps"][0]["input"]["offset"], 2);
        assert_eq!(checkpoint["completedSteps"][1]["type"], "update");
        assert!(checkpoint["completedSteps"][1]["input"].get("content").is_none());
        assert!(!checkpoint.to_string().contains("do-not-persist"));
    }
}
