//! 格物 Lattice 原生后端（Tauri 2）。
//!
//! 分层：
//! - `workspace` —— 统一写入边界（WorkspaceService）：单实例锁、哈希冲突、
//!   原子写、快照、审计与统一错误模型（升级计划 P1-01）；
//! - `vault`  —— 文件系统真源：安全路径校验、原子写、哈希冲突保护；
//! - `db`     —— SQLite 索引库连接与 Schema 迁移；
//! - `index`  —— FTS5 trigram 检索与增量扫描（可随时删除重建的投影）；
//! - `time`   —— ISO-8601 UTC 时间格式化。
//!
//! Phase 1 目标（见 lattice-architecture.html）：Express 后端退场，
//! 原本跑在 Node 进程里的 SQLite / FTS5 检索改为 Rust 侧原生驱动。

mod ai;
mod ai_runtime;
mod db;
mod index;
mod jobs;
mod markdown;
mod migration;
#[cfg(test)]
mod parity_tests;
mod time;
mod update;
mod vault;
mod watcher;
mod workspace;

use ai::{AiRetrievalRequest, AiRetrievalResponse};
use ai_runtime::{
    AiEventSink, AiRuntimeState, ai_chat_cancel, ai_chat_stream, ai_small_model,
    checkpoint_for_tool_calls, redact_request_secrets, sanitize_ai_persistence,
    sanitize_tool_checkpoint, stream_provider_round,
};
use index::{
    AiRelatedNote, FolderNode, GraphData, IndexStats, MetaOverview, NoteDetail, NoteIndexEntry,
    NoteMatch, ScanSummary, SearchOutcome, TagEntry,
};
use jobs::{AiRunEventRecord, Job};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use vault::{NoteContents, NoteFile, VaultAssetEntry, VaultInfo};
use workspace::{
    AttachmentCleanup, AttachmentEntry, AttachmentReferences, AttachmentUpload,
    AttachmentValidation, CanvasDocument, FileAction, FileFindOutcome, FileGrepOutcome,
    FileReadOutcome, FolderRecord, HistoryList, HistorySnapshot, McpProjectState, ServiceError,
    VaultFileEntry, WorkspaceService,
};

pub struct WorkspaceState(pub RwLock<WorkspaceService>);

/// 统一的状态访问入口：只读锁内执行动作，避免每个命令重复写锁样板。
/// ServiceError 转回契约文本（message 与原 vault 错误文本逐字一致）。
fn with_workspace<T>(
    state: State<'_, WorkspaceState>,
    action: impl FnOnce(&WorkspaceService) -> Result<T, ServiceError>,
) -> Result<T, String> {
    let workspace = state.0.read().map_err(|error| error.to_string())?;
    action(&workspace).map_err(|error| error.message)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let saved = app.path().app_config_dir()?.join("vault-path.txt");
            let root = std::env::var_os("LATTICE_VAULT_DIR")
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    std::fs::read_to_string(saved)
                        .ok()
                        .map(|path| std::path::PathBuf::from(path.trim()))
                })
                .filter(|path| path.is_dir())
                .unwrap_or(app.path().app_data_dir()?.join("vault"));
            let workspace = WorkspaceService::open(root)?;
            // The index is a rebuildable projection. Queue one startup scan so a
            // fresh Vault is visible without requiring an external file change.
            if let Err(error) = workspace.jobs().enqueue(
                "vault-scan",
                Some("startup"),
                &serde_json::json!({ "trigger": "startup" }),
            ) {
                log::warn!("启动扫描入队失败：{error}");
            }
            app.manage(WorkspaceState(RwLock::new(workspace)));
            app.manage(AiRuntimeState::default());
            app.handle().plugin(tauri_plugin_dialog::init())?;
            spawn_scan_worker(app.handle().clone());
            spawn_ai_worker(app.handle().clone());
            spawn_vault_watcher(app.handle().clone());
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_info,
            vault_profile_set,
            vault_migrate_sqlite,
            vault_assets_list,
            note_templates_list,
            note_create_from_template,
            note_create_daily,
            vault_open,
            vault_list,
            vault_read,
            vault_read_asset,
            vault_write,
            vault_search,
            vault_scan,
            vault_index_stats,
            job_list,
            job_get,
            job_cancel,
            tag_list,
            tag_delete,
            note_index,
            note_list,
            note_get,
            note_duplicate,
            note_create,
            note_update,
            note_delete,
            search_query,
            ai_retrieve,
            ai_related,
            ai_suggestions,
            ai_digest,
            ai_chat_stream,
            ai_chat_cancel,
            ai_provider_test,
            ai_small_model,
            ai_run_enqueue,
            ai_run_get,
            ai_run_events,
            ai_run_checkpoint,
            ai_run_cancel,
            ai_run_resume,
            ai_run_confirm,
            ai_run_feedback,
            ai_settings_get,
            ai_settings_set,
            ai_models_catalog,
            ai_provider_models,
            ai_runtime_detect,
            ai_prompts_list,
            ai_trace_query,
            memory_list,
            memory_save,
            memory_delete,
            note_history_list,
            note_history_get,
            note_history_restore,
            graph_build,
            folder_tree,
            folder_create,
            folder_update,
            folder_delete,
            meta_overview,
            canvas_list,
            canvas_read,
            canvas_write,
            canvas_move,
            canvas_delete,
            vault_attachments_list,
            vault_attachment_upload,
            vault_attachment_delete,
            vault_attachment_references,
            vault_files_list,
            vault_attachment_validate,
            vault_attachment_cleanup,
            vault_download,
            file_read,
            file_find,
            file_grep,
            file_preview,
            file_execute,
            file_undo,
            file_log,
            expert_list,
            expert_get,
            expert_save,
            expert_delete,
            expert_route,
            skill_list,
            skill_get,
            skill_save,
            skill_delete,
            review_health,
            review_plan,
            review_execute,
            mcp_project_get,
            mcp_project_set,
            update_check
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

#[tauri::command]
async fn update_check(current: Option<String>) -> Result<update::UpdateInfo, String> {
    update::check(current.as_deref()).await
}

#[tauri::command]
fn vault_info(state: State<'_, WorkspaceState>) -> Result<VaultInfo, String> {
    with_workspace(state, |workspace| Ok(workspace.vault_info()))
}

#[tauri::command]
fn mcp_project_get(state: State<'_, WorkspaceState>) -> Result<McpProjectState, String> {
    with_workspace(state, |workspace| workspace.mcp_project_get())
}

#[tauri::command]
fn mcp_project_set(
    state: State<'_, WorkspaceState>,
    document: serde_json::Value,
    confirmed: Option<bool>,
) -> Result<McpProjectState, String> {
    with_workspace(state, |workspace| {
        workspace.mcp_project_set(document, confirmed.unwrap_or(false))
    })
}

#[tauri::command]
fn memory_list(
    state: State<'_, WorkspaceState>,
    include_expired: Option<bool>,
) -> Result<Vec<crate::ai::core::context::memory::MemoryRecord>, String> {
    with_workspace(state, |workspace| {
        workspace.memory_list(include_expired.unwrap_or(false))
    })
}

/// 读取脱敏设置文档（密钥恒为掩码）+ 每 provider 的 keyAvailable（地基 §5.2）。
#[tauri::command]
fn ai_settings_get(state: State<'_, WorkspaceState>) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| workspace.ai_settings_load())
}

/// 保存设置：真实 Key 在 Rust 边界替换为掩码后落盘，返回脱敏文档。
#[tauri::command]
fn ai_settings_set(
    state: State<'_, WorkspaceState>,
    document: serde_json::Value,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.ai_settings_save(&document)
    })
}

/// 模型目录：内置 JSON + Vault 覆盖，含能力/价格/开放权重标记（W3）。
#[tauri::command]
fn ai_models_catalog(state: State<'_, WorkspaceState>) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| Ok(workspace.ai_models_catalog()))
}

/// 动态发现：GET {base}/models（OpenAI 兼容端点通用），归一化为模型清单。
#[tauri::command]
async fn ai_provider_models(
    endpoint: String,
    api_key: Option<String>,
    auth_header: Option<String>,
) -> Result<serde_json::Value, String> {
    let models = crate::ai::core::provider::discovery::discover_models(
        &endpoint,
        api_key.as_deref().unwrap_or(""),
        auth_header.as_deref().unwrap_or("bearer"),
    )
    .await?;
    serde_json::to_value(models).map_err(|error| format!("模型清单序列化失败：{error}"))
}

/// 扫描本机推理运行时（loopback 端口探测，免密钥；Ollama 优先走 /api/tags）。
#[tauri::command]
async fn ai_runtime_detect() -> Result<serde_json::Value, String> {
    let runtimes = crate::ai::core::provider::discovery::detect_local_runtimes().await;
    serde_json::to_value(runtimes).map_err(|error| format!("运行时结果序列化失败：{error}"))
}

/// Prompt 模板状态（W5）：id / 版本 / 是否被 `.lattice/prompts` 覆盖。
#[tauri::command]
fn ai_prompts_list(state: State<'_, WorkspaceState>) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        serde_json::to_value(workspace.ai_prompts_list()).map_err(|error| {
            workspace::ServiceError::new("PROMPT_STATUS_ERROR", format!("Prompt 状态序列化失败：{error}"))
        })
    })
}

/// AI 指标查询（W8）：最近明细 + 按 task_type 的 P50/P95 汇总（含成本/用量合计）。
#[tauri::command]
fn ai_trace_query(
    state: State<'_, WorkspaceState>,
    task_type: Option<String>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.ai_trace_query(task_type.as_deref(), limit.unwrap_or(50))
    })
}

#[tauri::command]
fn memory_save(
    state: State<'_, WorkspaceState>,
    id: Option<String>,
    kind: String,
    content: String,
    source: String,
    expires_at: Option<String>,
    confirmed: Option<bool>,
) -> Result<crate::ai::core::context::memory::MemoryRecord, String> {
    with_workspace(state, |workspace| {
        workspace.memory_save(
            id,
            kind,
            content,
            source,
            expires_at,
            confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn memory_delete(
    state: State<'_, WorkspaceState>,
    id: String,
    confirmed: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.memory_delete(&id, confirmed.unwrap_or(false))
    })
}

#[tauri::command]
fn vault_list(state: State<'_, WorkspaceState>) -> Result<Vec<NoteFile>, String> {
    // 列表只读索引，不碰磁盘；扫描由 `vault_scan` 单独负责。
    with_workspace(state, |workspace| {
        workspace
            .index()
            .list()
            .map_err(|error| ServiceError::new("INDEX_ERROR", error))
    })
}

#[tauri::command]
fn vault_read(state: State<'_, WorkspaceState>, path: String) -> Result<NoteContents, String> {
    with_workspace(state, |workspace| {
        workspace
            .vault()
            .read(&path)
            .map_err(|error| ServiceError::new("READ_ERROR", error))
    })
}

#[tauri::command]
fn vault_write(
    state: State<'_, WorkspaceState>,
    path: String,
    raw: String,
    expected_hash: Option<String>,
) -> Result<NoteContents, String> {
    with_workspace(state, |workspace| {
        workspace.write(&path, &raw, expected_hash.as_deref(), "ui")
    })
}

#[tauri::command]
fn vault_search(
    state: State<'_, WorkspaceState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<NoteMatch>, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .search(&query, limit.unwrap_or(20))
            .map_err(|error| ServiceError::new("SEARCH_ERROR", error))
    })
}

/// 增量对齐文件系统与索引：未变化的文件不读盘。
#[tauri::command]
fn vault_scan(state: State<'_, WorkspaceState>) -> Result<ScanSummary, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .scan(workspace.vault())
            .map_err(|error| ServiceError::new("SCAN_ERROR", error))
    })
}

#[tauri::command]
fn vault_index_stats(state: State<'_, WorkspaceState>) -> Result<IndexStats, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .stats()
            .map_err(|error| ServiceError::new("INDEX_ERROR", error))
    })
}

#[tauri::command]
fn vault_read_asset(state: State<'_, WorkspaceState>, path: String) -> Result<String, String> {
    with_workspace(state, |workspace| {
        workspace
            .vault()
            .read_asset(&path)
            .map_err(|error| ServiceError::new("ASSET_ERROR", error))
    })
}

#[tauri::command]
fn job_list(
    state: State<'_, WorkspaceState>,
    status: Option<String>,
    kind: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Job>, String> {
    with_workspace(state, |workspace| {
        workspace
            .jobs()
            .list(status.as_deref(), kind.as_deref(), limit.unwrap_or(50))
            .map_err(|error| ServiceError::new("JOBS_ERROR", error))
    })
}

#[tauri::command]
fn job_get(state: State<'_, WorkspaceState>, id: String) -> Result<Option<Job>, String> {
    with_workspace(state, |workspace| {
        workspace
            .jobs()
            .get(&id)
            .map_err(|error| ServiceError::new("JOBS_ERROR", error))
    })
}

#[tauri::command]
fn job_cancel(state: State<'_, WorkspaceState>, id: String) -> Result<Option<Job>, String> {
    with_workspace(state, |workspace| {
        workspace
            .jobs()
            .cancel(&id)
            .map_err(|error| ServiceError::new("JOBS_ERROR", error))
    })
}

fn request_run_id(request: &serde_json::Value) -> Result<String, String> {
    request
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "AI 请求缺少 runId".to_owned())
}

fn append_ai_event(handle: &tauri::AppHandle, run_id: &str, payload: &serde_json::Value) {
    let state = handle.state::<WorkspaceState>();
    if let Ok(workspace) = state.0.read() {
        let sequence = workspace.jobs().ai_event_count(run_id).unwrap_or(0) + 1;
        let persisted = sanitize_ai_persistence(payload);
        if let Err(error) = workspace.jobs().append_ai_event(run_id, sequence, &persisted) {
            log::warn!("AI Run 事件落盘失败：{error}");
        }
    }
}

#[tauri::command]
fn ai_run_enqueue(
    state: State<'_, WorkspaceState>,
    runtime: State<'_, AiRuntimeState>,
    request: serde_json::Value,
) -> Result<Job, String> {
    let run_id = request_run_id(&request)?;
    runtime.register_pending_request(&run_id, request.clone())?;
    let persisted = redact_request_secrets(&request);
    let job = with_workspace(state, |workspace| {
        let job = workspace
            .jobs()
            .enqueue("ai-run", Some(&run_id), &persisted)
            .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))?;
        if job.status == jobs::STATUS_QUEUED && job.attempts == 0 {
            let sequence = workspace.jobs().ai_event_count(&run_id).unwrap_or(0) + 1;
            workspace
                .jobs()
                .append_ai_event(
                    &run_id,
                    sequence,
                    &serde_json::json!({
                        "type": "status", "status": "queued", "text": "任务已排队"
                    }),
                )
                .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))?;
        }
        Ok(job)
    })?;
    Ok(job)
}

#[tauri::command]
fn ai_run_get(state: State<'_, WorkspaceState>, run_id: String) -> Result<Option<Job>, String> {
    with_workspace(state, |workspace| {
        workspace
            .jobs()
            .get_by_kind_key("ai-run", &run_id)
            .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))
    })
}

#[tauri::command]
fn ai_run_events(
    state: State<'_, WorkspaceState>,
    run_id: String,
    after_sequence: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<AiRunEventRecord>, String> {
    with_workspace(state, |workspace| {
        workspace
            .jobs()
            .ai_events(&run_id, after_sequence.unwrap_or(0), limit.unwrap_or(200))
            .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))
    })
}

#[tauri::command]
fn ai_run_checkpoint(
    state: State<'_, WorkspaceState>,
    run_id: String,
    checkpoint: serde_json::Value,
) -> Result<Option<Job>, String> {
    let checkpoint = sanitize_tool_checkpoint(&checkpoint)?;
    with_workspace(state, |workspace| {
        let Some(existing) = workspace
            .jobs()
            .get_by_kind_key("ai-run", &run_id)
            .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))?
        else {
            return Ok(None);
        };
        workspace
            .jobs()
            .set_checkpoint(&existing.id, &checkpoint)
            .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))
    })
}

#[tauri::command]
fn ai_run_cancel(
    state: State<'_, WorkspaceState>,
    runtime: State<'_, AiRuntimeState>,
    run_id: String,
) -> Result<Option<Job>, String> {
    let job = with_workspace(state, |workspace| {
        let Some(existing) = workspace
            .jobs()
            .get_by_kind_key("ai-run", &run_id)
            .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))?
        else {
            return Ok(None);
        };
        let job = workspace
            .jobs()
            .cancel(&existing.id)
            .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))?;
        if let Some(item) = &job {
            let sequence = workspace.jobs().ai_event_count(&run_id).unwrap_or(0) + 1;
            let payload = if item.status == jobs::STATUS_CANCELLED {
                serde_json::json!({ "type": "status", "status": "cancelled", "text": "任务已取消" })
            } else {
                serde_json::json!({ "type": "status", "status": "cancel_requested", "text": "正在取消任务" })
            };
            workspace
                .jobs()
                .append_ai_event(&run_id, sequence, &payload)
                .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))?;
        }
        Ok(job)
    })?;
    runtime.cancel(&run_id)?;
    Ok(job)
}

#[tauri::command]
fn ai_run_resume(
    state: State<'_, WorkspaceState>,
    runtime: State<'_, AiRuntimeState>,
    run_id: String,
    request: Option<serde_json::Value>,
) -> Result<Option<Job>, String> {
    // W7c：内核续跑（ai_run_confirm 已注册续跑请求并重新入队）优先——
    // 忽略前端附带请求，也不重复 resume，前端直接进入事件回放。
    let kernel_continuation = runtime.take_kernel_continuation(&run_id);
    if !kernel_continuation {
        if let Some(request) = request {
            let request_run = request_run_id(&request)?;
            if request_run != run_id {
                return Err("恢复请求的 runId 与目标任务不一致".to_owned());
            }
            runtime.register_pending_request(&run_id, request)?;
        }
    }
    with_workspace(state, |workspace| {
        let Some(existing) = workspace
            .jobs()
            .get_by_kind_key("ai-run", &run_id)
            .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))?
        else {
            return Ok(None);
        };
        if kernel_continuation {
            return Ok(Some(existing));
        }
        let job = workspace
            .jobs()
            .resume(&existing.id)
            .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))?;
        if let Some(item) = &job {
            if item.status == jobs::STATUS_QUEUED {
                let sequence = workspace.jobs().ai_event_count(&run_id).unwrap_or(0) + 1;
                let resumed_from = item.checkpoint.clone().unwrap_or(serde_json::Value::Null);
                workspace
                    .jobs()
                    .append_ai_event(
                        &run_id,
                        sequence,
                        &serde_json::json!({
                            "type": "status", "status": "queued", "text": "任务已恢复",
                            "resumedFrom": resumed_from
                        }),
                    )
                    .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))?;
            }
        }
        Ok(job)
    })
}

/// W7c 确认下沉：用户对挂起的写批次作出裁决后，由内核执行（或记录拒绝）、
/// 构建续跑请求、重新入队。前端只负责渲染预览与发送确认，不再自行执行写操作。
#[tauri::command]
fn ai_run_confirm(
    handle: tauri::AppHandle,
    runtime: State<'_, AiRuntimeState>,
    run_id: String,
    approved: bool,
    second_confirmed: bool,
    approved_call_ids: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let pending = runtime
        .take_pending_writes(&run_id)
        .ok_or_else(|| "该任务没有待确认的写操作".to_owned())?;
    let workspace_state = handle.state::<WorkspaceState>();
    let workspace = workspace_state
        .0
        .read()
        .map_err(|_| "工作区不可用".to_owned())?;
    let job = workspace
        .jobs()
        .get_by_kind_key("ai-run", &run_id)
        .map_err(|error| ServiceError::new("AI_RUN_ERROR", error).message)?
        .ok_or_else(|| "任务不存在".to_owned())?;
    if job.status != jobs::STATUS_WAITING_CONFIRMATION {
        return Err("任务不在等待确认状态".to_owned());
    }

    let mut tool_results = pending.executed_results.clone();
    let approved_ids: Option<std::collections::HashSet<String>> = approved_call_ids
        .map(|ids| ids.into_iter().collect());
    let mut executed_count = 0usize;
    let mut failed_count = 0usize;
    if approved {
        for call in &pending.pending {
            if let Some(approved_ids) = &approved_ids {
                if !approved_ids.contains(&call.id) {
                    tool_results.push(serde_json::json!({
                        "callId": call.id,
                        "result": { "status": "failed", "error": "用户跳过了该写操作" },
                    }));
                    continue;
                }
            }
            let Some((_, plan_hash)) = pending.plan_hashes.iter().find(|(id, _)| id == &call.id) else {
                failed_count += 1;
                tool_results.push(serde_json::json!({
                    "callId": call.id,
                    "result": { "status": "failed", "error": "写操作预览缺失，无法执行" },
                }));
                continue;
            };
            let key = format!("{run_id}:{}", call.id);
            match workspace.file_execute_with_context(
                crate::ai::core::agent::tools::write_action_from_call(call),
                None,
                true,
                second_confirmed || !pending.has_delete,
                None,
                Some(plan_hash.clone()),
                "local-user",
                "editor",
                None,
                Some(&key),
            ) {
                Ok(result) => {
                    executed_count += 1;
                    tool_results.push(serde_json::json!({ "callId": call.id, "result": result }));
                }
                Err(error) => {
                    failed_count += 1;
                    tool_results.push(serde_json::json!({
                        "callId": call.id,
                        "result": { "status": "failed", "error": error.message },
                    }));
                }
            }
        }
    } else {
        for call in &pending.pending {
            tool_results.push(serde_json::json!({
                "callId": call.id,
                "result": { "status": "failed", "error": "用户拒绝了该写操作" },
            }));
        }
    }

    // 确认/拒绝事件（路径与结果统计，不含写入正文）
    let sequence = workspace.jobs().ai_event_count(&run_id).unwrap_or(0) + 1;
    let (status, text) = if approved {
        (
            "tool_running",
            format!("已确认写操作：执行 {executed_count} 项，失败 {failed_count} 项，继续任务"),
        )
    } else {
        ("tool_running", "用户拒绝了写操作，等待模型调整方案".to_owned())
    };
    let _ = workspace.jobs().append_ai_event(
        &run_id,
        sequence,
        &serde_json::json!({ "type": "status", "status": status, "text": text }),
    );
    let _ = handle.emit(
        &format!("ai://stream/{run_id}"),
        serde_json::json!({ "type": "status", "status": status, "text": text }),
    );

    // 续跑请求与读写续跑同构（消息文本一致以稳定模型行为），由内核注册后重新入队
    let mut continuation = pending.continuation_request;
    continuation["message"] = serde_json::json!("请根据工具执行结果继续完成任务。");
    continuation["toolCalls"] = pending.calls;
    continuation["toolResults"] = serde_json::Value::Array(tool_results);
    continuation["preferModel"] = serde_json::json!(true);
    continuation["resumeRun"] = serde_json::json!(true);
    runtime.register_pending_request(&run_id, continuation)?;
    runtime.mark_kernel_continuation(&run_id);
    let job = workspace
        .jobs()
        .resume(&job.id)
        .map_err(|error| ServiceError::new("AI_RUN_ERROR", error).message)?;
    Ok(serde_json::json!({ "job": job, "executedCount": executed_count, "failedCount": failed_count }))
}

/// U3：消息反馈（👍/👎）落 trace——追加为 ai_run_events 的 feedback 事件
///（事件流 append-only，无需新表/迁移；rating 之外不携带任何正文）。
#[tauri::command]
fn ai_run_feedback(
    handle: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
    run_id: String,
    rating: String,
) -> Result<(), String> {
    if !matches!(rating.as_str(), "up" | "down") {
        return Err("反馈类型无效".to_owned());
    }
    with_workspace(state, |workspace| {
        let sequence = workspace.jobs().ai_event_count(&run_id).unwrap_or(0) + 1;
        workspace
            .jobs()
            .append_ai_event(
                &run_id,
                sequence,
                &serde_json::json!({ "type": "feedback", "rating": rating }),
            )
            .map_err(|error| ServiceError::new("AI_RUN_ERROR", error))?;
        Ok(())
    })?;
    let _ = handle.emit(
        &format!("ai://stream/{run_id}"),
        serde_json::json!({ "type": "feedback", "rating": rating }),
    );
    Ok(())
}

#[tauri::command]
fn tag_list(state: State<'_, WorkspaceState>) -> Result<Vec<TagEntry>, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .list_tags()
            .map_err(|error| ServiceError::new("TAGS_ERROR", error))
    })
}

#[tauri::command]
fn tag_delete(state: State<'_, WorkspaceState>, id: String) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .delete_tag(&id)
            .map_err(|error| ServiceError::new("TAGS_ERROR", error))
    })
}

#[tauri::command]
fn vault_profile_set(
    state: State<'_, WorkspaceState>,
    profile: serde_json::Value,
    confirmed: Option<bool>,
) -> Result<VaultInfo, String> {
    with_workspace(state, |workspace| {
        workspace.save_vault_profile(profile, confirmed.unwrap_or(false))
    })
}

#[tauri::command]
fn vault_migrate_sqlite(
    state: State<'_, WorkspaceState>,
    sqlite_path: String,
    confirmed: Option<bool>,
    second_confirmed: Option<bool>,
) -> Result<migration::MigrationSummary, String> {
    with_workspace(state, |workspace| {
        migration::migrate_sqlite(
            workspace,
            &sqlite_path,
            confirmed.unwrap_or(false),
            second_confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn vault_assets_list(state: State<'_, WorkspaceState>) -> Result<Vec<VaultAssetEntry>, String> {
    let workspace = state.0.read().map_err(|error| error.to_string())?;
    workspace.vault().list_assets()
}

#[tauri::command]
fn note_index(state: State<'_, WorkspaceState>) -> Result<Vec<NoteIndexEntry>, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .list_note_index()
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))
    })
}

#[tauri::command]
fn note_list(
    state: State<'_, WorkspaceState>,
    folder_id: Option<String>,
    tag_id: Option<String>,
    inbox_status: Option<String>,
    sort: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<serde_json::Value, String> {
    let workspace = state.0.read().map_err(|error| error.to_string())?;
    workspace
        .index()
        .list_notes(
            folder_id.as_deref(),
            tag_id.as_deref(),
            inbox_status.as_deref(),
            sort.as_deref().unwrap_or("updated"),
            limit.unwrap_or(50),
            offset.unwrap_or(0),
        )
        .map_err(|error| format!("NOTES_ERROR: {error}"))
}

#[tauri::command]
fn note_get(state: State<'_, WorkspaceState>, id: String) -> Result<NoteDetail, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .find_note_detail(Some(&id), None)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "笔记不存在"))
    })
}

#[tauri::command]
fn note_duplicate(
    state: State<'_, WorkspaceState>,
    id: String,
    folder_id: Option<String>,
    confirmed: Option<bool>,
) -> Result<NoteDetail, String> {
    with_workspace(state, |workspace| {
        workspace.duplicate_note(&id, folder_id, confirmed.unwrap_or(false))
    })
}

#[tauri::command]
fn note_templates_list(state: State<'_, WorkspaceState>) -> Result<Vec<serde_json::Value>, String> {
    with_workspace(state, |workspace| workspace.list_templates())
}

#[tauri::command]
fn note_create_from_template(
    state: State<'_, WorkspaceState>,
    template: String,
    title: Option<String>,
    date: Option<String>,
    folder_id: Option<String>,
    confirmed: Option<bool>,
) -> Result<NoteDetail, String> {
    with_workspace(state, |workspace| {
        workspace.create_from_template(
            &template,
            title,
            date,
            folder_id,
            confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn note_create_daily(
    state: State<'_, WorkspaceState>,
    date: Option<String>,
    confirmed: Option<bool>,
) -> Result<NoteDetail, String> {
    with_workspace(state, |workspace| {
        workspace.create_daily_note(date, confirmed.unwrap_or(false))
    })
}

#[tauri::command]
fn note_create(
    state: State<'_, WorkspaceState>,
    id: Option<String>,
    title: Option<String>,
    content: Option<String>,
    folder_id: Option<String>,
    properties: Option<serde_json::Map<String, serde_json::Value>>,
    confirmed: bool,
) -> Result<NoteDetail, String> {
    with_workspace(state, |workspace| {
        workspace.create_note(
            id,
            title,
            content.as_deref().unwrap_or(""),
            folder_id,
            &properties.unwrap_or_default(),
            confirmed,
        )
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // 契约参数形状对齐 PATCH /api/notes/:id
fn note_update(
    state: State<'_, WorkspaceState>,
    id: String,
    title: Option<String>,
    content: Option<String>,
    folder_id: Option<Option<String>>,
    is_pinned: Option<bool>,
    properties: Option<serde_json::Map<String, serde_json::Value>>,
    expected_hash: Option<String>,
    confirmed: Option<bool>,
) -> Result<NoteDetail, String> {
    with_workspace(state, |workspace| {
        workspace.update_note(
            &id,
            title,
            content,
            folder_id,
            is_pinned,
            properties,
            expected_hash,
            confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn note_delete(
    state: State<'_, WorkspaceState>,
    id: String,
    confirmed: Option<bool>,
    second_confirmed: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.delete_note(
            &id,
            confirmed.unwrap_or(false),
            second_confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn search_query(
    state: State<'_, WorkspaceState>,
    q: String,
    limit: Option<usize>,
    folder_id: Option<String>,
    inbox_status: Option<String>,
) -> Result<SearchOutcome, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .search_query(
                &q,
                limit.unwrap_or(30),
                folder_id.as_deref(),
                inbox_status.as_deref(),
            )
            .map_err(|error| ServiceError::new("SEARCH_ERROR", error))
    })
}

/// AI 检索命令：权限路径在 Index 的 FTS/LIKE SQL 条件中生效后，
/// 才组装块级引用，避免模型先看到再拦截。
#[tauri::command]
fn ai_retrieve(
    state: State<'_, WorkspaceState>,
    request: AiRetrievalRequest,
) -> Result<AiRetrievalResponse, String> {
    with_workspace(state, |workspace| {
        ai::retrieve(workspace.index(), request)
            .map_err(|error| ServiceError::new("SEARCH_ERROR", error))
    })
}

#[tauri::command]
fn ai_related(
    state: State<'_, WorkspaceState>,
    note_id: String,
    limit: Option<usize>,
) -> Result<Vec<AiRelatedNote>, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .related_notes(&note_id, limit.unwrap_or(6))
            .map_err(|error| ServiceError::new("SEARCH_ERROR", error))
    })
}

#[tauri::command]
fn ai_suggestions(
    state: State<'_, WorkspaceState>,
    note_id: String,
    limit: Option<usize>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .ai_suggestions(&note_id, limit.unwrap_or(6))
            .map_err(|error| ServiceError::new("SEARCH_ERROR", error))
    })
}

#[tauri::command]
fn ai_digest(
    state: State<'_, WorkspaceState>,
    date: Option<String>,
    confirmed: bool,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| workspace.generate_ai_digest(date, confirmed))
}

#[tauri::command]
async fn ai_provider_test(request: serde_json::Value) -> Result<serde_json::Value, String> {
    ai_runtime::ai_provider_test_runtime(request).await
}

#[tauri::command]
fn note_history_list(state: State<'_, WorkspaceState>, id: String) -> Result<HistoryList, String> {
    with_workspace(state, |workspace| workspace.history_list(&id))
}

#[tauri::command]
fn note_history_get(
    state: State<'_, WorkspaceState>,
    id: String,
    version: String,
) -> Result<HistorySnapshot, String> {
    with_workspace(state, |workspace| workspace.history_get(&id, &version))
}

#[tauri::command]
fn note_history_restore(
    state: State<'_, WorkspaceState>,
    id: String,
    version: String,
    expected_current_hash: Option<String>,
    confirmed: Option<bool>,
) -> Result<NoteDetail, String> {
    with_workspace(state, |workspace| {
        workspace.history_restore(
            &id,
            &version,
            expected_current_hash,
            confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn graph_build(state: State<'_, WorkspaceState>) -> Result<GraphData, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .build_graph()
            .map_err(|error| ServiceError::new("GRAPH_ERROR", error))
    })
}

#[tauri::command]
fn folder_tree(state: State<'_, WorkspaceState>) -> Result<Vec<FolderNode>, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .folder_tree(workspace.vault())
            .map_err(|error| ServiceError::new("FOLDERS_ERROR", error))
    })
}

#[tauri::command]
fn meta_overview(state: State<'_, WorkspaceState>) -> Result<MetaOverview, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .meta_overview(workspace.vault())
            .map_err(|error| ServiceError::new("META_ERROR", error))
    })
}

#[tauri::command]
fn folder_create(
    state: State<'_, WorkspaceState>,
    name: String,
    parent_id: Option<String>,
    sort_order: Option<u64>,
    confirmed: Option<bool>,
) -> Result<FolderRecord, String> {
    with_workspace(state, |workspace| {
        workspace.folder_create(
            &name,
            parent_id.as_deref(),
            sort_order,
            confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn folder_update(
    state: State<'_, WorkspaceState>,
    id: String,
    name: Option<String>,
    parent_id: Option<Option<String>>,
    sort_order: Option<u64>,
    confirmed: Option<bool>,
) -> Result<FolderRecord, String> {
    with_workspace(state, |workspace| {
        workspace.folder_update(
            &id,
            name,
            parent_id.as_ref().map(|value| value.as_deref()),
            sort_order,
            confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn folder_delete(
    state: State<'_, WorkspaceState>,
    id: String,
    confirmed: Option<bool>,
    second_confirmed: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.folder_delete(
            &id,
            confirmed.unwrap_or(false),
            second_confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn canvas_list(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<crate::workspace::CanvasFileEntry>, String> {
    with_workspace(state, |workspace| workspace.canvas_list())
}

#[tauri::command]
fn canvas_read(state: State<'_, WorkspaceState>, path: String) -> Result<CanvasDocument, String> {
    with_workspace(state, |workspace| workspace.canvas_read(&path))
}

#[tauri::command]
fn canvas_write(
    state: State<'_, WorkspaceState>,
    path: String,
    nodes: serde_json::Value,
    edges: serde_json::Value,
    expected_hash: Option<String>,
    confirmed: Option<bool>,
) -> Result<crate::workspace::CanvasWriteResult, String> {
    with_workspace(state, |workspace| {
        workspace.canvas_write(
            &path,
            nodes,
            edges,
            expected_hash.as_deref(),
            confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn canvas_move(
    state: State<'_, WorkspaceState>,
    from_path: String,
    to_path: String,
    confirmed: Option<bool>,
) -> Result<crate::workspace::CanvasMoveResult, String> {
    with_workspace(state, |workspace| {
        workspace.canvas_move(&from_path, &to_path, confirmed.unwrap_or(false))
    })
}

#[tauri::command]
fn canvas_delete(
    state: State<'_, WorkspaceState>,
    path: String,
    confirmed: Option<bool>,
    second_confirmed: Option<bool>,
) -> Result<crate::workspace::CanvasDeleteResult, String> {
    with_workspace(state, |workspace| {
        workspace.canvas_delete(
            &path,
            confirmed.unwrap_or(false),
            second_confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn vault_attachments_list(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<AttachmentEntry>, String> {
    with_workspace(state, |workspace| workspace.attachments_list())
}

#[tauri::command]
fn vault_attachment_upload(
    state: State<'_, WorkspaceState>,
    name: String,
    mime_type: Option<String>,
    folder: Option<String>,
    bytes: Vec<u8>,
    confirmed: Option<bool>,
) -> Result<AttachmentUpload, String> {
    with_workspace(state, |workspace| {
        workspace.attachment_upload(
            &name,
            mime_type.as_deref(),
            folder.as_deref(),
            bytes,
            confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn vault_attachment_delete(
    state: State<'_, WorkspaceState>,
    path: String,
    confirmed: Option<bool>,
    second_confirmed: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.attachment_delete(
            &path,
            confirmed.unwrap_or(false),
            second_confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn vault_attachment_references(
    state: State<'_, WorkspaceState>,
    path: String,
) -> Result<AttachmentReferences, String> {
    with_workspace(state, |workspace| workspace.attachment_references(&path))
}

#[tauri::command]
fn vault_files_list(state: State<'_, WorkspaceState>) -> Result<Vec<VaultFileEntry>, String> {
    with_workspace(state, |workspace| workspace.vault_files_list())
}

#[tauri::command]
fn vault_attachment_validate(
    state: State<'_, WorkspaceState>,
    content: String,
    file_path: Option<String>,
) -> Result<AttachmentValidation, String> {
    with_workspace(state, |workspace| {
        workspace.attachment_validate(&content, file_path.as_deref().unwrap_or(""))
    })
}

#[tauri::command]
fn vault_attachment_cleanup(
    state: State<'_, WorkspaceState>,
    dry_run: Option<bool>,
    confirmed: Option<bool>,
    second_confirmed: Option<bool>,
) -> Result<AttachmentCleanup, String> {
    with_workspace(state, |workspace| {
        workspace.attachment_cleanup(
            dry_run.unwrap_or(true),
            confirmed.unwrap_or(false),
            second_confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn vault_download(state: State<'_, WorkspaceState>, path: String) -> Result<String, String> {
    with_workspace(state, |workspace| {
        workspace.vault_download(&path).map(|value| value.base64)
    })
}

#[tauri::command]
fn file_read(
    state: State<'_, WorkspaceState>,
    path: String,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Result<FileReadOutcome, String> {
    with_workspace(state, |workspace| {
        workspace.file_read(&path, offset.unwrap_or(0), limit)
    })
}

#[tauri::command]
fn file_find(
    state: State<'_, WorkspaceState>,
    pattern: Option<String>,
    dir: Option<String>,
    file_type: Option<String>,
) -> Result<FileFindOutcome, String> {
    with_workspace(state, |workspace| {
        workspace.file_find(pattern, dir, file_type)
    })
}

#[tauri::command]
fn file_grep(
    state: State<'_, WorkspaceState>,
    query: String,
    dir: Option<String>,
    regex: Option<bool>,
    file_type: Option<String>,
) -> Result<FileGrepOutcome, String> {
    with_workspace(state, |workspace| {
        workspace.file_grep(query, dir, regex.unwrap_or(false), file_type)
    })
}

#[tauri::command]
fn file_preview(
    state: State<'_, WorkspaceState>,
    action: Option<FileAction>,
    actions: Option<Vec<FileAction>>,
    actor: Option<String>,
    role: Option<String>,
    allowed_paths: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.file_preview_with_context(
            action,
            actions,
            actor.as_deref().unwrap_or("local-user"),
            role.as_deref().unwrap_or("editor"),
            allowed_paths.as_deref(),
        )
    })
}

#[tauri::command]
fn file_execute(
    state: State<'_, WorkspaceState>,
    action: Option<FileAction>,
    actions: Option<Vec<FileAction>>,
    confirmed: Option<bool>,
    second_confirmed: Option<bool>,
    plan_id: Option<String>,
    plan_hash: Option<String>,
    actor: Option<String>,
    role: Option<String>,
    allowed_paths: Option<Vec<String>>,
    idempotency_key: Option<String>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.file_execute_with_context(
            action,
            actions,
            confirmed.unwrap_or(false),
            second_confirmed.unwrap_or(false),
            plan_id,
            plan_hash,
            actor.as_deref().unwrap_or("local-user"),
            role.as_deref().unwrap_or("editor"),
            allowed_paths.as_deref(),
            idempotency_key.as_deref(),
        )
    })
}

#[tauri::command]
fn file_undo(
    state: State<'_, WorkspaceState>,
    operation_id: Option<String>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.file_undo(operation_id, force.unwrap_or(false))
    })
}

#[tauri::command]
fn file_log(
    state: State<'_, WorkspaceState>,
    limit: Option<u64>,
) -> Result<Vec<serde_json::Value>, String> {
    with_workspace(state, |workspace| workspace.file_log(limit))
}

#[tauri::command]
fn expert_list(state: State<'_, WorkspaceState>) -> Result<Vec<serde_json::Value>, String> {
    with_workspace(state, |workspace| workspace.expert_list())
}

#[tauri::command]
fn expert_get(state: State<'_, WorkspaceState>, id: String) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| workspace.expert_get(&id))
}

#[tauri::command]
fn expert_save(
    state: State<'_, WorkspaceState>,
    expert: serde_json::Value,
    id: Option<String>,
    confirmed: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.expert_save(expert, id, confirmed.unwrap_or(false))
    })
}

#[tauri::command]
fn expert_delete(
    state: State<'_, WorkspaceState>,
    id: String,
    confirmed: Option<bool>,
    second_confirmed: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.expert_delete(
            &id,
            confirmed.unwrap_or(false),
            second_confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn expert_route(
    state: State<'_, WorkspaceState>,
    message: String,
    exclude_id: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    with_workspace(state, |workspace| {
        workspace.expert_route(&message, exclude_id)
    })
}

#[tauri::command]
fn skill_list(state: State<'_, WorkspaceState>) -> Result<Vec<serde_json::Value>, String> {
    with_workspace(state, |workspace| workspace.skill_list())
}

#[tauri::command]
fn skill_get(state: State<'_, WorkspaceState>, id: String) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| workspace.skill_get(&id))
}

#[tauri::command]
fn skill_save(
    state: State<'_, WorkspaceState>,
    skill: serde_json::Value,
    id: Option<String>,
    confirmed: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.skill_save(skill, id, confirmed.unwrap_or(false))
    })
}

#[tauri::command]
fn skill_delete(
    state: State<'_, WorkspaceState>,
    id: String,
    confirmed: Option<bool>,
    second_confirmed: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.skill_delete(
            &id,
            confirmed.unwrap_or(false),
            second_confirmed.unwrap_or(false),
        )
    })
}

#[tauri::command]
fn review_health(
    state: State<'_, WorkspaceState>,
    stale_days: Option<u64>,
    limit: Option<u64>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.review_health(stale_days.unwrap_or(90), limit.unwrap_or(100))
    })
}

#[tauri::command]
fn review_plan(
    state: State<'_, WorkspaceState>,
    finding_ids: Vec<String>,
    stale_days: Option<u64>,
    limit: Option<u64>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.review_plan(finding_ids, stale_days.unwrap_or(90), limit.unwrap_or(100))
    })
}

#[tauri::command]
fn review_execute(
    state: State<'_, WorkspaceState>,
    plan_id: String,
    plan_hash: String,
    confirmed: Option<bool>,
    second_confirmed: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_workspace(state, |workspace| {
        workspace.review_execute(
            &plan_id,
            &plan_hash,
            confirmed.unwrap_or(false),
            second_confirmed.unwrap_or(false),
        )
    })
}

/// 后台扫描执行器：领取 `vault-scan` 任务 → 取消检查 → 增量 reconcile →
/// 完成并广播统计。空闲时每秒轮询（单机场景足够，避免复杂唤醒机制）。
fn spawn_scan_worker(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            let claimed = {
                let state = handle.state::<WorkspaceState>();
                let workspace = state.0.read().map_err(|error| error.to_string());
                match workspace {
                    Ok(workspace) => workspace.jobs().claim_next("vault-scan"),
                    Err(_) => break,
                }
            };
            match claimed {
                Ok(Some(job)) => {
                    if matches!(handle.state::<WorkspaceState>().0.read(), Ok(workspace) if matches!(workspace.jobs().checkpoint_cancelled(&job.id), Ok(true)))
                    {
                        continue;
                    }
                    let outcome = {
                        let state = handle.state::<WorkspaceState>();
                        match state.0.read() {
                            Ok(workspace) => workspace
                                .index()
                                .scan(workspace.vault())
                                .map_err(|error| ServiceError::new("SCAN_ERROR", error)),
                            Err(error) => Err(ServiceError::new("STATE_ERROR", error.to_string())),
                        }
                    };
                    let jobs_result = {
                        let state = handle.state::<WorkspaceState>();
                        match state.0.read() {
                            Ok(workspace) => match &outcome {
                                Ok(summary) => workspace
                                    .jobs()
                                    .complete(
                                        &job.id,
                                        &serde_json::to_value(summary).unwrap_or_default(),
                                    )
                                    .map(|_| ()),
                                Err(error) => {
                                    workspace.jobs().fail(&job.id, &error.message).map(|_| ())
                                }
                            },
                            Err(_) => Ok(()),
                        }
                    };
                    if let Err(error) = jobs_result {
                        log::warn!("任务结果落盘失败：{error}");
                    }
                    if let Ok(summary) = outcome {
                        let _ = handle.emit("vault://scanned", &summary);
                    }
                }
                _ => std::thread::sleep(Duration::from_millis(1000)),
            }
        }
    });
}

/// AI 后台执行器：Run 主状态落在 jobs，流式事件追加到 ai_run_events。
/// 关闭面板只会丢失实时订阅，不会停止当前进程中的执行；重新打开时可按
/// sequence 从持久化事件表补拉。网络失败沿用 jobs 的有限重试，写工具幂等键
/// 仍由前端 Gateway 负责。
fn spawn_ai_worker(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            let claimed = {
                let state = handle.state::<WorkspaceState>();
                match state.0.read() {
                    Ok(workspace) => workspace.jobs().claim_next("ai-run"),
                    Err(error) => Err(error.to_string()),
                }
            };
            let Ok(Some(job)) = claimed else {
                if claimed.is_err() {
                    std::thread::sleep(Duration::from_millis(1000));
                } else {
                    std::thread::sleep(Duration::from_millis(500));
                }
                continue;
            };

            let run_id = job.key.clone().unwrap_or_else(|| job.id.clone());
            let runtime = handle.state::<AiRuntimeState>().inner().clone();
            if matches!(handle.state::<WorkspaceState>().0.read(), Ok(workspace) if matches!(workspace.jobs().checkpoint_cancelled(&job.id), Ok(true)))
            {
                append_ai_event(
                    &handle,
                    &run_id,
                    &serde_json::json!({
                        "type": "status", "status": "cancelled", "text": "任务已取消"
                    }),
                );
                continue;
            }

            let request = match runtime.pending_request(&run_id) {
                Ok(Some(request)) => request,
                Ok(None) => {
                    let message = "后台任务无法恢复模型凭据，请重新提交任务";
                    append_ai_event(
                        &handle,
                        &run_id,
                        &serde_json::json!({
                            "type": "error", "message": message
                        }),
                    );
                    if let Ok(workspace) = handle.state::<WorkspaceState>().0.read() {
                        let _ = workspace.jobs().fail_permanently(&job.id, message);
                    }
                    continue;
                }
                Err(error) => {
                    if let Ok(workspace) = handle.state::<WorkspaceState>().0.read() {
                        let _ = workspace.jobs().fail_permanently(&job.id, &error);
                    }
                    continue;
                }
            };

            append_ai_event(
                &handle,
                &run_id,
                &serde_json::json!({
                    "type": "status", "status": "generating", "text": "后台任务开始执行"
                }),
            );
            if let Ok(workspace) = handle.state::<WorkspaceState>().0.read() {
                let _ = workspace.jobs().set_checkpoint(
                    &job.id,
                    &serde_json::json!({
                        "stage": "generating",
                        "sequence": workspace.jobs().ai_event_count(&run_id).unwrap_or(0)
                    }),
                );
            }
            let sequence = Arc::new(AtomicI64::new(
                handle
                    .state::<WorkspaceState>()
                    .0
                    .read()
                    .ok()
                    .and_then(|workspace| workspace.jobs().ai_event_count(&run_id).ok())
                    .unwrap_or(0),
            ));
            let event_handle = handle.clone();
            let event_run_id = run_id.clone();
            let sink: AiEventSink = Arc::new(move |payload| {
                let next = sequence.fetch_add(1, Ordering::SeqCst) + 1;
                let persisted = sanitize_ai_persistence(payload);
                if let Ok(workspace) = event_handle.state::<WorkspaceState>().0.read() {
                    if let Err(error) =
                        workspace
                            .jobs()
                            .append_ai_event(&event_run_id, next, &persisted)
                    {
                        log::warn!("AI Run 流事件落盘失败：{error}");
                    }
                }
            });
            if let Err(error) = runtime.start(&run_id) {
                if let Ok(workspace) = handle.state::<WorkspaceState>().0.read() {
                    let _ = workspace.jobs().fail_permanently(&job.id, &error);
                }
                continue;
            }
            // W7b：Agent 读工具循环下沉 worker——关面板不再中断多轮检索/读取。
            // 只有「全部为已注册读工具且预算允许」才内核续跑；出现写工具、
            // 预算耗尽或解析异常时按原行为收尾（done 带原 toolCalls 交回前端）。
            let agent_budget = crate::ai::core::agent::budget_for_mode(
                request
                    .get("mode")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("quick"),
            );
            let tool_registry = crate::ai::core::agent::ToolRegistry::builtin();
            // W8：跨轮累计用量与首字延迟，run 结束一次性落 ai_trace
            let trace_mode = request
                .get("mode")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("quick")
                .to_owned();
            let trace_started = std::time::Instant::now();
            let mut trace_ttft_ms: Option<u64> = None;
            let mut trace_prompt_tokens: u64 = 0;
            let mut trace_completion_tokens: u64 = 0;
            let mut trace_total_tokens: u64 = 0;
            let mut agent_steps: u32 = 1;
            let mut remaining_tool_calls = agent_budget.max_tool_calls;
            // W7c：内核已执行的写调用 id（跨轮累计，终态 done 的 meta 里回传给前端过滤）
            let mut kernel_write_ids: Vec<String> = Vec::new();
            // W7c：写轮预算终局（不再等待确认，任务直接完成）
            let mut write_round_final = false;
            let mut current_request = request;
            let mut result = tauri::async_runtime::block_on(stream_provider_round(
                handle.clone(),
                runtime.clone(),
                run_id.clone(),
                current_request.clone(),
                Some(sink.clone()),
                false,
            ));
            loop {
                if runtime.is_cancelled(&run_id) {
                    break;
                }
                let Ok(ref payload) = result else {
                    break;
                };
                if payload.get("cancelled").and_then(serde_json::Value::as_bool) == Some(true) {
                    break;
                }
                // W8：累计本轮用量；TTFT 取首轮（多轮 run 的用户感知首字）
                if let Some(usage) = payload.pointer("/meta/usage").and_then(|value| value.as_object()) {
                    trace_prompt_tokens += usage
                        .get("prompt_tokens")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0);
                    trace_completion_tokens += usage
                        .get("completion_tokens")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0);
                    trace_total_tokens += usage
                        .get("total_tokens")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0);
                }
                if trace_ttft_ms.is_none() {
                    trace_ttft_ms = payload
                        .pointer("/meta/ttftMs")
                        .and_then(serde_json::Value::as_u64);
                }
                let Some(calls_value) = payload.get("toolCalls").and_then(|value| value.as_array())
                else {
                    break;
                };
                if calls_value.is_empty() {
                    break;
                }
                let pending_calls: Vec<crate::ai::core::agent::PendingCall> = calls_value
                    .iter()
                    .map(|call| crate::ai::core::agent::PendingCall {
                        id: call
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        name: call
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        input: call.get("input").cloned().unwrap_or_else(|| serde_json::json!({})),
                    })
                    .collect();
                let registry_kind = |name: &str| {
                    tool_registry
                        .get(name)
                        .map(|descriptor| descriptor.kind)
                };
                let has_writes = pending_calls
                    .iter()
                    .any(|call| registry_kind(&call.name) == Some(crate::ai::core::agent::ToolKind::Write));
                let tool_results: Vec<serde_json::Value>;
                if !has_writes {
                    // W7b 读轮原样：仅当全部为已注册读工具且预算允许才内核续跑，
                    // 出现未注册工具或预算/步数耗尽时交回前端（done 带原 toolCalls）。
                    let all_reads = pending_calls
                        .iter()
                        .all(|call| registry_kind(&call.name) == Some(crate::ai::core::agent::ToolKind::Read));
                    if !all_reads
                        || agent_steps >= agent_budget.max_steps
                        || remaining_tool_calls < pending_calls.len() as u32
                    {
                        break;
                    }
                    tool_results = {
                        let workspace_state = handle.state::<WorkspaceState>();
                        let Ok(workspace) = workspace_state.0.read() else {
                            break;
                        };
                        pending_calls
                            .iter()
                            .map(|call| {
                                serde_json::json!({
                                    "callId": call.id,
                                    "result": crate::ai::core::agent::tools::execute_read_call(&workspace, call),
                                })
                            })
                            .collect()
                    };
                    agent_steps += 1;
                    remaining_tool_calls -= pending_calls.len() as u32;
                    append_ai_event(
                        &handle,
                        &run_id,
                        &serde_json::json!({
                            "type": "status", "status": "tool_running",
                            "text": format!("已执行 {} 个检索/读取，继续生成", pending_calls.len())
                        }),
                    );
                } else {
                    // W7c 写轮由内核接管：Runner 计划驱动——读并行、Auto(L0/L1) 写串行直执
                    // （预览→planHash→execute，审计/快照/undo 走文件内核既有管线）、
                    // 未注册/越权/超预算拒绝；仅 L2/L3 写挂起等用户确认（正文只存进程内存）。
                    let confirmations = std::collections::HashSet::new();
                    let plan = crate::ai::core::agent::plan_execution(
                        &tool_registry,
                        &crate::ai::core::agent::RunnerInput {
                            calls: &pending_calls,
                            remaining_tool_calls,
                            writes_allowed: true,
                            confirmations_granted: &confirmations,
                        },
                    );
                    let mut results_by_call: std::collections::HashMap<String, serde_json::Value> =
                        std::collections::HashMap::new();
                    {
                        let workspace_state = handle.state::<WorkspaceState>();
                        let Ok(workspace) = workspace_state.0.read() else {
                            break;
                        };
                        for read in &plan.reads {
                            if let Some(call) = pending_calls.iter().find(|call| call.id == read.id) {
                                results_by_call.insert(
                                    read.id.clone(),
                                    crate::ai::core::agent::tools::execute_read_call(&workspace, call),
                                );
                            }
                        }
                        for write in &plan.writes {
                            if write.gate != crate::ai::core::agent::WriteGate::Auto {
                                continue; // NeedsConfirmation 在下方挂起；Granted 只出现在确认续跑轮
                            }
                            let Some(call) = pending_calls.iter().find(|call| call.id == write.call.id) else {
                                continue;
                            };
                            let key = format!("{run_id}:{}", write.call.id);
                            results_by_call.insert(
                                write.call.id.clone(),
                                crate::ai::core::agent::tools::execute_write_call(&workspace, call, &key),
                            );
                            kernel_write_ids.push(write.call.id.clone());
                            let summary = call
                                .input
                                .get("type")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("write");
                            append_ai_event(
                                &handle,
                                &run_id,
                                &serde_json::json!({
                                    "type": "status", "status": "tool_running",
                                    "text": format!("已执行写操作（{summary}），继续任务")
                                }),
                            );
                        }
                        for rejected in &plan.rejected {
                            results_by_call.insert(
                                rejected.id.clone(),
                                serde_json::json!({ "status": "failed", "error": rejected.reason }),
                            );
                        }
                    }
                    let needs_confirmation: Vec<crate::ai::core::agent::PendingCall> = plan
                        .writes
                        .iter()
                        .filter(|write| {
                            matches!(
                                write.gate,
                                crate::ai::core::agent::WriteGate::NeedsConfirmation { .. }
                            )
                        })
                        .filter_map(|write| {
                            pending_calls.iter().find(|call| call.id == write.call.id).cloned()
                        })
                        .collect();
                    if !needs_confirmation.is_empty() {
                        let mut plan_hashes: Vec<(String, String)> = Vec::new();
                        let mut confirmed_pending: Vec<crate::ai::core::agent::PendingCall> = Vec::new();
                        let mut write_requests: Vec<serde_json::Value> = Vec::new();
                        for write in &plan.writes {
                            let crate::ai::core::agent::WriteGate::NeedsConfirmation { level, reason } = &write.gate else {
                                continue;
                            };
                            write_requests.push(serde_json::json!({
                                "id": write.call.id,
                                "name": write.call.name,
                                "level": level,
                                "reason": reason,
                            }));
                        }
                        {
                            let workspace_state = handle.state::<WorkspaceState>();
                            if let Ok(workspace) = workspace_state.0.read() {
                                for call in &needs_confirmation {
                                    match crate::ai::core::agent::tools::preview_write_call(&workspace, call) {
                                        Ok(plan_hash) => {
                                            plan_hashes.push((call.id.clone(), plan_hash));
                                            confirmed_pending.push(call.clone());
                                        }
                                        Err(error) => {
                                            results_by_call.insert(
                                                call.id.clone(),
                                                serde_json::json!({ "status": "failed", "error": error }),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        tool_results = pending_calls
                            .iter()
                            .map(|call| {
                                serde_json::json!({
                                    "callId": call.id,
                                    "result": results_by_call.get(&call.id).cloned().unwrap_or_else(|| {
                                        serde_json::json!({ "status": "failed", "error": "工具未被计划执行" })
                                    }),
                                })
                            })
                            .collect();
                        if !confirmed_pending.is_empty() {
                            let has_delete = confirmed_pending.iter().any(|call| {
                                call.input.get("type").and_then(serde_json::Value::as_str) == Some("delete")
                            });
                            if let Err(error) = runtime.store_pending_writes(
                                &run_id,
                                crate::ai::runtime::run_worker::PendingWriteConfirmation {
                                    continuation_request: current_request.clone(),
                                    calls: serde_json::Value::Array(calls_value.clone()),
                                    executed_results: tool_results.clone(),
                                    pending: confirmed_pending,
                                    plan_hashes,
                                    has_delete,
                                },
                            ) {
                                log::warn!("挂起写批次保存失败：{error}");
                            }
                            append_ai_event(
                                &handle,
                                &run_id,
                                &serde_json::json!({
                                    "type": "status", "status": "write_confirmation",
                                    "text": format!("{} 项写操作等待用户确认", write_requests.len())
                                }),
                            );
                            if let Ok(payload) = result.as_mut() {
                                payload["meta"]["awaitingConfirmation"] = serde_json::json!(true);
                                payload["meta"]["completionStatus"] =
                                    serde_json::json!("waiting_confirmation");
                                payload["meta"]["kernelManaged"] = serde_json::json!(true);
                                payload["meta"]["kernelWriteExecuted"] =
                                    serde_json::json!(kernel_write_ids);
                                payload["writeRequests"] = serde_json::json!(write_requests);
                            }
                            break;
                        }
                    } else {
                        tool_results = pending_calls
                            .iter()
                            .map(|call| {
                                serde_json::json!({
                                    "callId": call.id,
                                    "result": results_by_call.get(&call.id).cloned().unwrap_or_else(|| {
                                        serde_json::json!({ "status": "failed", "error": "工具未被计划执行" })
                                    }),
                                })
                            })
                            .collect();
                    }
                    agent_steps += 1;
                    remaining_tool_calls -= (plan.reads.len() + plan.writes.len()) as u32;
                    if agent_steps >= agent_budget.max_steps || remaining_tool_calls == 0 {
                        // 写轮预算终局：不交回前端绕过预算（预算只收紧），任务直接完成；
                        // kernelManaged 标注让前端不再对这批 toolCalls 构建执行预览。
                        append_ai_event(
                            &handle,
                            &run_id,
                            &serde_json::json!({
                                "type": "status", "status": "completed",
                                "text": "任务工具预算已达上限，已执行的工具结果生效"
                            }),
                        );
                        if let Ok(payload) = result.as_mut() {
                            payload["meta"]["kernelManaged"] = serde_json::json!(true);
                            payload["meta"]["completionStatus"] = serde_json::json!("completed");
                            payload["meta"]["kernelWriteExecuted"] =
                                serde_json::json!(kernel_write_ids);
                        }
                        write_round_final = true;
                        break;
                    }
                    append_ai_event(
                        &handle,
                        &run_id,
                        &serde_json::json!({
                            "type": "status", "status": "tool_running",
                            "text": format!("已执行 {} 项工具（含写操作），继续生成", pending_calls.len())
                        }),
                    );
                }
                // 续跑请求与 web 旧循环同构（消息文本保持一致以稳定模型行为），
                // 但由内核构建，前端不再产生伪用户消息
                let mut continuation = current_request.clone();
                continuation["message"] =
                    serde_json::json!("请根据工具执行结果继续完成任务。");
                continuation["toolCalls"] = serde_json::Value::Array(calls_value.clone());
                continuation["toolResults"] = serde_json::Value::Array(tool_results);
                continuation["preferModel"] = serde_json::json!(true);
                continuation["resumeRun"] = serde_json::json!(true);
                current_request = continuation;
                result = tauri::async_runtime::block_on(stream_provider_round(
                    handle.clone(),
                    runtime.clone(),
                    run_id.clone(),
                    current_request.clone(),
                    Some(sink.clone()),
                    false,
                ));
            }
            // 终态 done 统一由 worker 发出（取消轮已自带 done(cancelled)）
            if let Ok(ref payload) = result {
                if payload.get("cancelled").and_then(serde_json::Value::as_bool) != Some(true) {
                    sink(&serde_json::json!({ "type": "done", "payload": payload.clone() }));
                    let _ = handle.emit(
                        &format!("ai://stream/{run_id}"),
                        serde_json::json!({ "type": "done", "payload": payload.clone() }),
                    );
                    // W8：run 维度计量落库（正文/凭据永不入库；成本按 W3 目录单价估算）
                    let trace_model = payload
                        .pointer("/meta/model")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let trace_cost = if trace_model.is_empty() {
                        None
                    } else {
                        crate::ai::core::trace::estimate_cost_usd(
                            &crate::ai::core::provider::catalog::ModelCatalog::builtin(),
                            &trace_model,
                            trace_prompt_tokens,
                            trace_completion_tokens,
                        )
                    };
                    let trace_entry = crate::ai::core::trace::TraceEntry {
                        run_id: run_id.clone(),
                        task_type: trace_mode.clone(),
                        provider: "tauri".to_owned(),
                        model: trace_model,
                        ttft_ms: trace_ttft_ms,
                        duration_ms: Some(trace_started.elapsed().as_millis() as u64),
                        prompt_tokens: Some(trace_prompt_tokens),
                        completion_tokens: Some(trace_completion_tokens),
                        total_tokens: Some(trace_total_tokens),
                        cost_usd: trace_cost,
                    };
                    let workspace_state = handle.state::<WorkspaceState>();
                    if let Ok(workspace) = workspace_state.0.read() {
                        if let Err(error) = workspace.ai_trace_record(&trace_entry) {
                            log::warn!("AI 指标落库失败：{}", error.message);
                        }
                    }
                }
            }
            runtime.finish(&run_id);

            if let Ok(workspace) = handle.state::<WorkspaceState>().0.read() {
                match result {
                    Ok(payload)
                        if payload
                            .get("cancelled")
                            .and_then(serde_json::Value::as_bool)
                            == Some(true) =>
                    {
                        let _ = workspace.jobs().finish_cancelled(&job.id);
                        let _ = workspace
                            .jobs()
                            .set_checkpoint(&job.id, &serde_json::json!({ "stage": "cancelled" }));
                        append_ai_event(
                            &handle,
                            &run_id,
                            &serde_json::json!({
                                "type": "status", "status": "cancelled", "text": "任务已取消"
                            }),
                        );
                    }
                    Ok(payload) => {
                        let persisted = sanitize_ai_persistence(&payload);
                        let tool_checkpoint = if write_round_final {
                            // W7c：写轮预算终局已无未决工具，检查点直接收口
                            serde_json::json!({ "stage": "completed" })
                        } else {
                            checkpoint_for_tool_calls(&payload)
                                .unwrap_or_else(|error| {
                                    log::warn!("AI tool checkpoint 构建失败：{error}");
                                    None
                                })
                                .unwrap_or_else(|| serde_json::json!({ "stage": "completed" }))
                        };
                        let _ = workspace.jobs().set_checkpoint(&job.id, &tool_checkpoint);
                        let has_tool_calls = payload
                            .get("toolCalls")
                            .and_then(serde_json::Value::as_array)
                            .is_some_and(|calls| !calls.is_empty());
                        // W7c：写轮预算终局直接完成；其余带 toolCalls 的终态（读轮交回 /
                        // 写确认挂起）仍进入等待确认，由前端回放读结果或发送确认。
                        if has_tool_calls && !write_round_final {
                            let _ = workspace.jobs().wait_for_confirmation(&job.id, &persisted);
                        } else {
                            let _ = workspace.jobs().complete(&job.id, &persisted);
                        }
                        let waiting = has_tool_calls && !write_round_final;
                        append_ai_event(
                            &handle,
                            &run_id,
                            &serde_json::json!({
                                "type": "status",
                                "status": if waiting { "waiting_confirmation" } else { "completed" },
                                "text": if waiting { "等待工具处理或用户确认" } else { "后台任务已完成" }
                            }),
                        );
                    }
                    Err(error) => {
                        let _ = workspace.jobs().set_checkpoint(
                            &job.id,
                            &serde_json::json!({ "stage": "failed", "retryable": true }),
                        );
                        append_ai_event(
                            &handle,
                            &run_id,
                            &serde_json::json!({
                                "type": "error", "message": error
                            }),
                        );
                        let _ = workspace.jobs().fail(&job.id, "AI 模型调用失败");
                    }
                }
            }
            let terminal = handle
                .state::<WorkspaceState>()
                .0
                .read()
                .ok()
                .and_then(|workspace| workspace.jobs().get(&job.id).ok().flatten())
                .map(|item| matches!(item.status.as_str(), "completed" | "failed" | "cancelled"))
                .unwrap_or(false);
            if terminal {
                runtime.clear_pending_request(&run_id);
            }
        }
    });
}

/// watcher 线程：外部编辑器改动 → 防抖 → 入队 reconcile 任务 → 通知前端。
fn spawn_vault_watcher(handle: tauri::AppHandle) {
    let root = {
        let state = handle.state::<WorkspaceState>();
        match state.0.read() {
            Ok(workspace) => workspace.path().to_path_buf(),
            Err(_) => return,
        }
    };
    std::thread::spawn(move || {
        if let Err(error) = watcher::spawn_watcher(&root, move || {
            let state = handle.state::<WorkspaceState>();
            let enqueued = match state.0.read() {
                Ok(workspace) => watcher::enqueue_reconcile(workspace.jobs()),
                Err(_) => return,
            };
            if let Ok(job_id) = enqueued {
                let _ = handle.emit("vault://changed", job_id);
            }
        }) {
            log::warn!("vault watcher 未能启动：{error}");
        }
    });
}

#[tauri::command]
fn vault_open(
    state: State<'_, WorkspaceState>,
    path: String,
    app: tauri::AppHandle,
) -> Result<VaultInfo, String> {
    let requested = PathBuf::from(path);
    if !requested.is_absolute() || !requested.is_dir() {
        return Err("Choose an existing Vault directory".into());
    }
    // 重开同一 Vault 走幂等分支：避免自我抢占单实例锁。
    {
        let current = state.0.read().map_err(|error| error.to_string())?;
        if current.is_same_root(&requested) {
            return Ok(current.vault_info());
        }
    }
    // 先完整打开（含索引库与单实例锁）再落盘配置，任何一步失败都不会留下半个状态。
    let next = WorkspaceService::open(requested).map_err(|error| error.message)?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    std::fs::write(
        config_dir.join("vault-path.txt"),
        next.path().to_string_lossy().as_bytes(),
    )
    .map_err(|error| format!("无法记录 Vault 路径：{error}"))?;

    let info = next.vault_info();
    let mut current = state.0.write().map_err(|error| error.to_string())?;
    *current = next;
    Ok(info)
}
