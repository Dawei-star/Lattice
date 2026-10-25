//! P1-08 功能对齐验证 · 第 2 步：Rust 通道 vs Express 通道的可执行结构对齐断言。
//!
//! 思路（与 `tests/tools/record-fixtures.mjs` 录制的 fixtures 对齐）：
//!  1. 用 `tests/fixtures/seed/vault` 重建同一份确定性 Vault（并预播种技能/专家，
//!     与录制脚本的 seed 步骤等价），跑一次索引构建，使服务层可用；
//!  2. 按录制时序，为每个 fixture case 调用**对应的服务层方法**，把返回值序列化成
//!     `serde_json::Value`，再按 fixtures 同款规则递归推导 schema；
//!  3. 与 fixture 里的 Express `schema` 做**字段级差异**比对（缺字段 / 多字段 / 类型不同），
//!     路径写成 `$.data[0].properties` 这种；
//!  4. 把差异集合与 `tests/fixtures/divergence.json`（本测试首次运行生成并落盘的期望清单）
//!     逐条比对，断言「实际差异 == 期望差异」。
//!
//! 目的：CI 全绿的同时把两通道的差距固化成**可度量的清单**。将来谁修好一处
//! （例如给 Rust `NoteDetail` 补上 `properties` 对象），实际差异会少一条，
//! 测试随即失败并提示把该条从 `divergence.json` 里删掉——把「修好了」变成可执行信号。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::index::stable_folder_id;
use crate::time::{iso8601_utc, now_millis};
use crate::workspace::{FileAction, WorkspaceService};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

fn fixtures_dir() -> PathBuf {
    PathBuf::from(FIXTURES)
}

fn cases_dir() -> PathBuf {
    fixtures_dir().join("cases")
}

fn divergence_path() -> PathBuf {
    fixtures_dir().join("divergence.json")
}

// ───────────────────────────── 播种与重建 Vault ─────────────────────────────

/// 递归复制 seed/vault 到临时目录。
fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let to = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), &to).unwrap();
        }
    }
}

/// 重建确定性 Vault：seed/vault → 临时目录，并显式刷新笔记 mtime，
/// 使 `modified_at DESC` 稳定为 [Alpha, Beta, 待移动, 待删除]（与 Express 首元素一致），
/// 保证数组「首元素 schema」比对可复现。
fn rebuild_seed_vault(target: &Path) {
    copy_tree(&fixtures_dir().join("seed").join("vault"), target);
    let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    let ordered = [
        ("Alpha 笔记.md", 40u64),
        ("项目/Beta 笔记.md", 30),
        ("待移动笔记.md", 20),
        ("项目/归档/待删除笔记.md", 10),
    ];
    for (relative, offset) in ordered {
        let path = target.join(relative);
        let raw = fs::read_to_string(&path).unwrap();
        // 录制快照把真实时间归一成占位符；回放时恢复到“现在附近”的有效值，
        // 这样健康扫描不会把确定性 fixture 误判成超过 staleDays 的旧笔记。
        let timestamp = iso8601_utc(now_millis() - offset as i64 * 1_000);
        fs::write(&path, raw.replace("<timestamp>", &timestamp)).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(base + Duration::from_secs(offset))
            .unwrap();
    }
}

/// 预播种技能（与 record-fixtures.mjs 的 seed 等价）。
fn seed_skill() -> Value {
    serde_json::json!({
        "id": "fix-skill",
        "name": "固定技能",
        "description": "固定技能描述",
        "content": "这是固定技能内容",
        "triggers": ["固定"],
        "tools": ["read"],
        "permissions": ["read"],
        "enabled": true,
    })
}

/// 预播种专家（与 record-fixtures.mjs 的 seed 等价）。
fn seed_expert() -> Value {
    serde_json::json!({
        "id": "fix-expert",
        "name": "固定专家",
        "description": "固定专家描述",
        "icon": "sparkles",
        "enabled": true,
        "systemPrompt": "你是固定专家",
        "scope": { "include": ["固定"], "exclude": [] },
        "skills": [{ "id": "fix-skill", "enabled": true, "priority": 60, "config": {} }],
        "routing": { "keywords": ["固定", "专家"], "priority": 80, "confidenceThreshold": 0.5 },
    })
}

// ───────────────────────────── 参数读取辅助 ─────────────────────────────

fn http_path(case: &Value) -> String {
    case["http"]["path"].as_str().unwrap_or("").to_owned()
}

fn nth_segment(path: &str, index: usize) -> String {
    path.split('/').nth(index).unwrap_or("").to_owned()
}

fn query(case: &Value, key: &str) -> Option<Value> {
    let value = &case["http"]["query"][key];
    if value.is_null() {
        None
    } else {
        Some(value.clone())
    }
}

fn body(case: &Value, key: &str) -> Option<Value> {
    let value = &case["http"]["body"][key];
    if value.is_null() {
        None
    } else {
        Some(value.clone())
    }
}

fn q_str(case: &Value, key: &str) -> Option<String> {
    query(case, key).and_then(|value| value.as_str().map(str::to_owned))
}

fn q_u64(case: &Value, key: &str) -> Option<u64> {
    query(case, key).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
    })
}

fn b_str(case: &Value, key: &str) -> Option<String> {
    body(case, key).and_then(|value| value.as_str().map(str::to_owned))
}

/// 从 case 的 http.body 还原 FileAction（未知键如 confirmed/planId 被忽略）。
fn body_action(case: &Value) -> FileAction {
    serde_json::from_value(case["http"]["body"].clone()).expect("body 可反序列化为 FileAction")
}

fn to_value<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("服务层返回值可序列化")
}

/// 差异标记前缀：服务层报错时把错误本身包成一个可辨识的字符串。
const ERROR_MARKER: &str = "<error>";

/// 统一错误捕获：服务层出错时不 panic，而是把错误本身序列化成可辨识标记，
/// 使「Express 有结果、Rust 报错」也被记成一条差异（kind: "error"），
/// 而不是让整份差异清单因一处 panic 而产不出来。兼容 `ServiceError` 与 `String` 两种错误。
fn capture<T: Serialize, E: std::fmt::Display>(result: Result<T, E>) -> Value {
    match result {
        Ok(value) => to_value(value),
        Err(error) => Value::String(format!("{ERROR_MARKER}{error}")),
    }
}

/// 若值是错误标记，取出其中的错误消息。
fn error_message(value: &Value) -> Option<&str> {
    value
        .as_str()
        .and_then(|text| text.strip_prefix(ERROR_MARKER))
}

// ───────────────────────────── 回放 ─────────────────────────────

/// 按录制时序回放全部 50 个 case，返回 (command, Rust 返回值)。
fn run_replay() -> Vec<(String, Value)> {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("vault");
    fs::create_dir_all(&root).unwrap();
    rebuild_seed_vault(&root);

    let service = WorkspaceService::open(root).unwrap();
    // seed 等价：技能 + 专家（写进 <vault>/.lattice）。属前置条件，出错不 panic，
    // 后续命令会各自暴露为差异。
    let _ = capture(service.skill_save(seed_skill(), None, true));
    let _ = capture(service.expert_save(seed_expert(), None, true));
    // 索引构建（Rust 内部命令 vault_scan）
    let _ = capture(service.index().scan(service.vault()));

    let mut out: Vec<(String, Value)> = Vec::new();

    let mut push = |command: &str, value: Value| out.push((command.to_owned(), value));

    // ── vault（10）：与 record-fixtures 同序 ─────────────────────────────
    {
        let case = load_case("vault_info");
        push("vault_info", to_value(service.vault_info()));
        let _ = case;
    }
    {
        let case = load_case("vault_attachment_upload");
        let name = q_str(&case, "name").unwrap_or_default();
        let confirmed = q_str(&case, "confirmed").as_deref() == Some("true");
        push(
            "vault_attachment_upload",
            capture(
                service
                    .attachment_upload(
                        &name,
                        Some("text/plain"),
                        None,
                        b"attachment fixture\n".to_vec(),
                        confirmed,
                    )
                    .map(|value| value),
            ),
        );
    }
    push(
        "vault_attachments_list",
        capture(service.attachments_list()),
    );
    push("vault_files_list", capture(service.vault_files_list()));
    {
        let case = load_case("vault_attachment_references");
        let path = q_str(&case, "path").unwrap_or_default();
        push(
            "vault_attachment_references",
            capture(service.attachment_references(&path)),
        );
    }
    {
        let case = load_case("vault_attachment_validate");
        let content = b_str(&case, "content").unwrap_or_default();
        let file_path = b_str(&case, "filePath").unwrap_or_default();
        push(
            "vault_attachment_validate",
            capture(service.attachment_validate(&content, &file_path)),
        );
    }
    {
        let case = load_case("vault_attachment_cleanup");
        let dry_run = body(&case, "dryRun")
            .and_then(|value| value.as_bool())
            .unwrap_or(true);
        let confirmed = body(&case, "confirmed")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let second = body(&case, "secondConfirmed")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        push(
            "vault_attachment_cleanup",
            capture(service.attachment_cleanup(dry_run, confirmed, second)),
        );
    }
    {
        let case = load_case("vault_read_asset");
        let path = q_str(&case, "path").unwrap_or_default();
        push(
            "vault_read_asset",
            capture(service.vault().read_asset(&path)),
        );
    }
    {
        let case = load_case("vault_download");
        let path = q_str(&case, "path").unwrap_or_default();
        push(
            "vault_download",
            capture(service.vault_download(&path).map(|value| value.base64)),
        );
    }
    {
        let case = load_case("vault_attachment_delete");
        let path = q_str(&case, "path").unwrap_or_default();
        let confirmed = q_str(&case, "confirmed").as_deref() == Some("true");
        let second = q_str(&case, "secondConfirmed").as_deref() == Some("true");
        push(
            "vault_attachment_delete",
            capture(service.attachment_delete(&path, confirmed, second)),
        );
    }

    // ── notes（7） ─────────────────────────────────────────────────────
    push("note_index", capture(service.index().list_note_index()));
    {
        let case = load_case("note_create");
        let id = b_str(&case, "id");
        let title = b_str(&case, "title");
        let content = b_str(&case, "content").unwrap_or_default();
        let folder_id = b_str(&case, "folderId");
        let properties = body(&case, "properties")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        push(
            "note_create",
            capture(service.create_note(id, title, &content, folder_id, &properties, true)),
        );
    }
    {
        let case = load_case("note_update");
        let id = nth_segment(&http_path(&case), 3);
        let content = b_str(&case, "content");
        let folder_id = body(&case, "folderId").map(|value| {
            if value.is_null() {
                None
            } else {
                value.as_str().map(str::to_owned)
            }
        });
        push(
            "note_update",
            capture(service.update_note(&id, None, content, folder_id, None, None, None, true)),
        );
    }
    let alpha_version = {
        let case = load_case("note_history_list");
        let id = nth_segment(&http_path(&case), 3);
        let history = capture(service.history_list(&id));
        let version = history["items"][0]["version"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_default();
        push("note_history_list", history);
        version
    };
    {
        let case = load_case("note_history_get");
        let id = nth_segment(&http_path(&case), 3);
        push(
            "note_history_get",
            capture(service.history_get(&id, &alpha_version)),
        );
    }
    {
        let case = load_case("note_history_restore");
        let id = nth_segment(&http_path(&case), 3);
        push(
            "note_history_restore",
            capture(service.history_restore(&id, &alpha_version, None, true)),
        );
    }
    {
        let case = load_case("note_delete");
        let id = nth_segment(&http_path(&case), 3);
        push("note_delete", capture(service.delete_note(&id, true, true)));
    }

    // ── tags / search / graph / meta（4） ──────────────────────────────
    push("tag_list", capture(service.index().list_tags()));
    {
        let case = load_case("search_query");
        let q = q_str(&case, "q").unwrap_or_default();
        let limit = q_u64(&case, "limit").unwrap_or(30) as usize;
        let folder_id = case["http"]["query"]["folderId"].as_str();
        let inbox_status = case["http"]["query"]["inboxStatus"].as_str();
        let result = capture(
            service
                .index()
                .search_query(&q, limit, folder_id, inbox_status),
        );
        let items = result.get("items").cloned().unwrap_or(result);
        push("search_query", items);
    }
    push("graph_build", capture(service.index().build_graph()));
    push(
        "meta_overview",
        capture(service.index().meta_overview(service.vault())),
    );

    // ── folders（4） ───────────────────────────────────────────────────
    push(
        "folder_tree",
        capture(service.index().folder_tree(service.vault())),
    );
    let created_folder_id = {
        // Express 的 parentId 是随机 id（fixture 里为 <uuid>）；Rust 收父目录路径，
        // 按 seed 清单映射为「项目」（seed.folders[0]）。
        let case = load_case("folder_create");
        let name = b_str(&case, "name").unwrap_or_default();
        let node = service.folder_create(&name, Some(&stable_folder_id("项目")), Some(1), true);
        let id = node
            .as_ref()
            .ok()
            .map(|node| node.id.clone())
            .unwrap_or_default();
        push("folder_create", capture(node));
        id
    };
    {
        let case = load_case("folder_update");
        let name = b_str(&case, "name");
        push(
            "folder_update",
            capture(service.folder_update(&created_folder_id, name, None, None, true)),
        );
    }
    {
        let case = load_case("folder_delete");
        let id = stable_folder_id("项目/新目录改名");
        let _ = case;
        push(
            "folder_delete",
            capture(service.folder_delete(&id, true, true)),
        );
    }

    // ── canvas（5） ────────────────────────────────────────────────────
    push("canvas_list", capture(service.canvas_list()));
    {
        let case = load_case("canvas_read");
        let path = q_str(&case, "path").unwrap_or_default();
        push("canvas_read", capture(service.canvas_read(&path)));
    }
    {
        let case = load_case("canvas_write");
        let path = q_str(&case, "path").unwrap_or_default();
        let nodes = body(&case, "nodes").unwrap_or(Value::Null);
        let edges = body(&case, "edges").unwrap_or(Value::Null);
        push(
            "canvas_write",
            capture(service.canvas_write(&path, nodes, edges, None, true)),
        );
    }
    {
        let case = load_case("canvas_move");
        let from = b_str(&case, "fromPath").unwrap_or_default();
        let to = b_str(&case, "toPath").unwrap_or_default();
        push(
            "canvas_move",
            capture(service.canvas_move(&from, &to, true)),
        );
    }
    {
        let case = load_case("canvas_delete");
        let path = q_str(&case, "path").unwrap_or_default();
        push(
            "canvas_delete",
            capture(service.canvas_delete(&path, true, true)),
        );
    }

    // ── files（7） ─────────────────────────────────────────────────────
    {
        let case = load_case("file_read");
        let path = q_str(&case, "path").unwrap_or_default();
        let offset = q_u64(&case, "offset").unwrap_or(0);
        let limit = q_u64(&case, "limit");
        push(
            "file_read",
            capture(service.file_read(&path, offset, limit)),
        );
    }
    {
        let case = load_case("file_find");
        let pattern = q_str(&case, "pattern");
        let dir = q_str(&case, "dir");
        push("file_find", capture(service.file_find(pattern, dir, None)));
    }
    {
        let case = load_case("file_grep");
        let q = q_str(&case, "query").unwrap_or_default();
        let dir = q_str(&case, "dir");
        let regex = q_str(&case, "regex").as_deref() == Some("true");
        push("file_grep", capture(service.file_grep(q, dir, regex, None)));
    }
    {
        let case = load_case("file_preview");
        let action = body_action(&case);
        push(
            "file_preview",
            capture(service.file_preview(Some(action), None)),
        );
    }
    let executed_operation_id = {
        let case = load_case("file_execute");
        let action = body_action(&case);
        // 录制时先做了一次隐藏预览取得 planId/planHash；Rust 侧同样先预览再执行。
        let preview = capture(service.file_preview(Some(action.clone()), None));
        let plan_id = preview["plan"]["id"].as_str().map(str::to_owned);
        let plan_hash = preview["planHash"].as_str().map(str::to_owned);
        let executed =
            capture(service.file_execute(Some(action), None, true, false, plan_id, plan_hash));
        let operation_id = executed["operationId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_default();
        push("file_execute", executed);
        operation_id
    };
    push(
        "file_undo",
        capture(service.file_undo(Some(executed_operation_id), false)),
    );
    {
        let case = load_case("file_log");
        let limit = q_u64(&case, "limit");
        push("file_log", capture(service.file_log(limit)));
    }

    // ── experts（9） ───────────────────────────────────────────────────
    push("expert_list", capture(service.expert_list()));
    {
        let case = load_case("expert_get");
        let id = nth_segment(&http_path(&case), 3);
        push("expert_get", capture(service.expert_get(&id)));
    }
    {
        let case = load_case("expert_save");
        let input = case["http"]["body"].clone();
        push(
            "expert_save",
            capture(service.expert_save(input, None, true)),
        );
    }
    {
        let case = load_case("expert_delete");
        let id = nth_segment(&http_path(&case), 3);
        push(
            "expert_delete",
            capture(service.expert_delete(&id, true, true)),
        );
    }
    {
        let case = load_case("expert_route");
        let message = b_str(&case, "message").unwrap_or_default();
        push(
            "expert_route",
            capture(service.expert_route(&message, None)),
        );
    }
    push("skill_list", capture(service.skill_list()));
    {
        let case = load_case("skill_get");
        let id = nth_segment(&http_path(&case), 4);
        push("skill_get", capture(service.skill_get(&id)));
    }
    {
        let case = load_case("skill_save");
        let input = case["http"]["body"].clone();
        push("skill_save", capture(service.skill_save(input, None, true)));
    }
    {
        let case = load_case("skill_delete");
        let id = nth_segment(&http_path(&case), 4);
        push(
            "skill_delete",
            capture(service.skill_delete(&id, true, true)),
        );
    }

    // ── review（3） ────────────────────────────────────────────────────
    push("review_health", capture(service.review_health(90, 100)));
    let (review_plan_id, review_plan_hash) = {
        let case = load_case("review_plan");
        let finding_ids = body(&case, "findingIds")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let plan = capture(service.review_plan(finding_ids, 90, 100));
        let id = plan["id"].as_str().map(str::to_owned).unwrap_or_default();
        let hash = plan["planHash"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_default();
        push("review_plan", plan);
        (id, hash)
    };
    push(
        "review_execute",
        capture(service.review_execute(&review_plan_id, &review_plan_hash, true, true)),
    );

    // ── jobs（1） ──────────────────────────────────────────────────────
    push("job_list", capture(service.jobs().list(None, None, 50)));

    // ── ai settings（2，W1 新增）───────────────────────────────────────
    // 先 set 后 get：get 的夹具数据即 set 落盘结果 + keyAvailable。
    {
        let case = load_case("ai_settings_set");
        push(
            "ai_settings_set",
            capture(service.ai_settings_save(&case["http"]["body"])),
        );
    }
    push("ai_settings_get", capture(service.ai_settings_load()));

    out
}

fn load_case(command: &str) -> Value {
    let path = cases_dir().join(format!("{command}.json"));
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("读取 fixture {} 失败：{error}", path.display()));
    serde_json::from_str(&raw).unwrap()
}

// ───────────────────────────── schema 与差异 ─────────────────────────────

/// 由数据递归推导的结构描述（与 record-fixtures.mjs 的 schemaOf 同规则）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Schema {
    Null,
    Boolean,
    Number,
    String,
    /// `None` 表示空数组（无首元素）。
    Array(Option<Box<Schema>>),
    Object(BTreeMap<String, Schema>),
}

impl Schema {
    fn of(value: &Value) -> Schema {
        match value {
            Value::Null => Schema::Null,
            Value::Bool(_) => Schema::Boolean,
            Value::Number(_) => Schema::Number,
            Value::String(_) => Schema::String,
            Value::Array(items) => {
                Schema::Array(items.first().map(|item| Box::new(Schema::of(item))))
            }
            Value::Object(fields) => Schema::Object(
                fields
                    .iter()
                    .map(|(key, item)| (key.clone(), Schema::of(item)))
                    .collect(),
            ),
        }
    }

    /// 解析 fixture 里已落盘的 schema（`{type, fields|element|length}`）。
    fn parse(value: &Value) -> Schema {
        match value["type"].as_str() {
            Some("null") => Schema::Null,
            Some("boolean") => Schema::Boolean,
            Some("number") => Schema::Number,
            Some("string") => Schema::String,
            Some("array") => {
                let element = &value["element"];
                Schema::Array(if element.is_null() {
                    None
                } else {
                    Some(Box::new(Schema::parse(element)))
                })
            }
            Some("object") => Schema::Object(
                value["fields"]
                    .as_object()
                    .map(|fields| {
                        fields
                            .iter()
                            .map(|(key, item)| (key.clone(), Schema::parse(item)))
                            .collect()
                    })
                    .unwrap_or_default(),
            ),
            other => panic!("fixture schema 类型未知：{other:?}"),
        }
    }

    fn type_name(&self) -> &'static str {
        match self {
            Schema::Null => "null",
            Schema::Boolean => "boolean",
            Schema::Number => "number",
            Schema::String => "string",
            Schema::Array(_) => "array",
            Schema::Object(_) => "object",
        }
    }
}

/// 一条字段级差异。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
struct Divergence {
    /// 形如 `$.data[0].properties`。
    path: String,
    /// `missing-in-rust` / `extra-in-rust` / `type-mismatch`。
    kind: String,
    express: String,
    rust: String,
}

impl Divergence {
    fn missing(path: String, express: &Schema) -> Self {
        Self {
            path,
            kind: "missing-in-rust".into(),
            express: express.type_name().into(),
            rust: "absent".into(),
        }
    }

    fn extra(path: String, rust: &Schema) -> Self {
        Self {
            path,
            kind: "extra-in-rust".into(),
            express: "absent".into(),
            rust: rust.type_name().into(),
        }
    }

    fn mismatch(path: String, express: &Schema, rust: &Schema) -> Self {
        Self {
            path,
            kind: "type-mismatch".into(),
            express: express.type_name().into(),
            rust: rust.type_name().into(),
        }
    }

    /// Rust 侧调用服务层直接报错（Express 侧正常返回）——最该被记录的差异。
    fn error(path: String, express: &Schema, message: &str) -> Self {
        Self {
            path,
            kind: "error".into(),
            express: express.type_name().into(),
            rust: message.to_owned(),
        }
    }
}

/// 递归比对 Express 与 Rust 的 schema，收集字段级差异。
fn diff_schema(express: &Schema, rust: &Schema, path: &str, out: &mut Vec<Divergence>) {
    if express.type_name() != rust.type_name() {
        out.push(Divergence::mismatch(path.to_owned(), express, rust));
        // 类型都不同时，仍把对象侧字段枚举出来，保证「Rust 缺少的字段」可见
        // （例如 DELETE /folders/:id：Express 是对象、Rust 是数组，需暴露 affectedNoteCount）。
        if let Schema::Object(fields) = express {
            for (key, value) in fields {
                out.push(Divergence::missing(format!("{path}.{key}"), value));
            }
        }
        if let Schema::Object(fields) = rust {
            for (key, value) in fields {
                out.push(Divergence::extra(format!("{path}.{key}"), value));
            }
        }
        return;
    }
    match (express, rust) {
        (Schema::Object(express_fields), Schema::Object(rust_fields)) => {
            for (key, value) in express_fields {
                match rust_fields.get(key) {
                    Some(other) => diff_schema(value, other, &format!("{path}.{key}"), out),
                    None => out.push(Divergence::missing(format!("{path}.{key}"), value)),
                }
            }
            for (key, value) in rust_fields {
                if !express_fields.contains_key(key) {
                    out.push(Divergence::extra(format!("{path}.{key}"), value));
                }
            }
        }
        (Schema::Array(express_element), Schema::Array(rust_element)) => {
            match (express_element, rust_element) {
                (Some(a), Some(b)) => diff_schema(a, b, &format!("{path}[0]"), out),
                (None, None) => {}
                (Some(a), None) => out.push(Divergence {
                    path: format!("{path}[0]"),
                    kind: "type-mismatch".into(),
                    express: a.type_name().into(),
                    rust: "empty".into(),
                }),
                (None, Some(b)) => out.push(Divergence {
                    path: format!("{path}[0]"),
                    kind: "type-mismatch".into(),
                    express: "empty".into(),
                    rust: b.type_name().into(),
                }),
            }
        }
        _ => {}
    }
}

/// 计算全部 case 的差异清单（command → 排序后的差异）。
fn compute_divergences() -> BTreeMap<String, Vec<Divergence>> {
    let mut map: BTreeMap<String, Vec<Divergence>> = BTreeMap::new();
    for (command, rust_data) in run_replay() {
        let case = load_case(&command);
        let express_schema = Schema::parse(&case["schema"]);
        // Rust 侧报错：记成一条 kind: "error" 的差异，不再向下做结构比对。
        if let Some(message) = error_message(&rust_data) {
            map.insert(
                command,
                vec![Divergence::error("$".into(), &express_schema, message)],
            );
            continue;
        }
        let rust_schema = Schema::of(&rust_data);
        let mut divergences = Vec::new();
        diff_schema(&express_schema, &rust_schema, "$.data", &mut divergences);
        divergences.sort();
        divergences.dedup();
        if !divergences.is_empty() {
            map.insert(command, divergences);
        }
    }
    map
}

// ───────────────────────────── 测试 ─────────────────────────────

#[test]
fn rust_express_structural_parity() {
    let actual = compute_divergences();

    let total: usize = actual.values().map(Vec::len).sum();
    println!(
        "P1-08 结构对齐：{} 条命令存在字段级差异，共 {} 条差异记录",
        actual.len(),
        total,
    );
    for (command, divergences) in &actual {
        println!("  [{command}] {} 条", divergences.len());
        for divergence in divergences {
            println!(
                "    {} {} (express={}, rust={})",
                divergence.path, divergence.kind, divergence.express, divergence.rust
            );
        }
    }

    let actual_flat: BTreeSet<(String, Divergence)> = actual
        .iter()
        .flat_map(|(command, list)| list.iter().map(move |item| (command.clone(), item.clone())))
        .collect();

    let path = divergence_path();
    if !path.exists() {
        let document = serde_json::json!({
            "note": "P1-08 结构对齐差异清单（由 src-tauri/src/parity_tests.rs 生成）。\
        每条含 command/path/kind/express/rust。Rust 侧修好一处后该条会消失，测试会失败并提示删除。",
            "commands": actual,
        });
        fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&document).unwrap()),
        )
        .unwrap();
        panic!(
            "首次运行：已生成差异清单基线 {}。请核对后提交，再重跑测试。",
            path.display()
        );
    }

    let document: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let mut expected: BTreeMap<String, Vec<Divergence>> = BTreeMap::new();
    if let Some(commands) = document["commands"].as_object() {
        for (command, list) in commands {
            expected.insert(
                command.clone(),
                serde_json::from_value(list.clone()).unwrap_or_else(|error| {
                    panic!("解析 divergence.json 中 {command} 失败：{error}")
                }),
            );
        }
    }
    let expected_flat: BTreeSet<(String, Divergence)> = expected
        .iter()
        .flat_map(|(command, list)| list.iter().map(move |item| (command.clone(), item.clone())))
        .collect();

    let disappeared: Vec<_> = expected_flat.difference(&actual_flat).collect();
    let appeared: Vec<_> = actual_flat.difference(&expected_flat).collect();

    if !disappeared.is_empty() || !appeared.is_empty() {
        let mut message = String::new();
        message.push_str("P1-08 结构对齐差异清单与 divergence.json 不一致。\n");
        if !disappeared.is_empty() {
            message.push_str("\n差异消失，请更新 divergence.json。\n");
            message.push_str("\n以下差异在期望清单里、但实际已不存在（Rust 可能已对齐，请从 divergence.json 删除对应条目）：\n");
            for (command, item) in &disappeared {
                message.push_str(&format!(
                    "  - [{command}] {} {} (express={}, rust={})\n",
                    item.path, item.kind, item.express, item.rust
                ));
            }
        }
        if !appeared.is_empty() {
            message.push_str(
                "\n以下差异实际出现、但未记录在期望清单里（请补充进 divergence.json）：\n",
            );
            for (command, item) in &appeared {
                message.push_str(&format!(
                    "  - [{command}] {} {} (express={}, rust={})\n",
                    item.path, item.kind, item.express, item.rust
                ));
            }
        }
        panic!("{message}");
    }

    println!(
        "实际差异与 divergence.json 完全一致（{} 条）",
        actual_flat.len()
    );
}
