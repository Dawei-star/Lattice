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

mod db;
mod index;
mod jobs;
mod markdown;
mod time;
mod vault;
mod watcher;
mod workspace;

use index::{FolderNode, GraphData, IndexStats, MetaOverview, NoteDetail, NoteIndexEntry, NoteMatch, ScanSummary, SearchOutcome, TagEntry};
use jobs::Job;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use vault::{NoteContents, NoteFile, VaultInfo};
use workspace::{HistoryEntry, HistorySnapshot, ServiceError, WorkspaceService};

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
            app.manage(WorkspaceState(RwLock::new(WorkspaceService::open(root)?)));
            app.handle().plugin(tauri_plugin_dialog::init())?;
            spawn_scan_worker(app.handle().clone());
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
            note_index,
            note_create,
            note_update,
            note_delete,
            search_query,
            note_history_list,
            note_history_get,
            note_history_restore,
            graph_build,
            folder_tree,
            folder_create,
            folder_update,
            folder_delete,
            meta_overview
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

#[tauri::command]
fn vault_info(state: State<'_, WorkspaceState>) -> Result<VaultInfo, String> {
    with_workspace(state, |workspace| {
        Ok(VaultInfo {
            path: workspace.path().to_string_lossy().into_owned(),
        })
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
fn note_index(state: State<'_, WorkspaceState>) -> Result<Vec<NoteIndexEntry>, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .list_note_index()
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))
    })
}

#[tauri::command]
fn note_create(
    state: State<'_, WorkspaceState>,
    id: Option<String>,
    title: Option<String>,
    content: Option<String>,
    properties: Option<serde_json::Map<String, serde_json::Value>>,
    confirmed: bool,
) -> Result<NoteDetail, String> {
    with_workspace(state, |workspace| {
        workspace.create_note(
            id,
            title,
            content.as_deref().unwrap_or(""),
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
) -> Result<bool, String> {
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
) -> Result<SearchOutcome, String> {
    with_workspace(state, |workspace| {
        workspace
            .index()
            .search_query(&q, limit.unwrap_or(20))
            .map_err(|error| ServiceError::new("SEARCH_ERROR", error))
    })
}

#[tauri::command]
fn note_history_list(state: State<'_, WorkspaceState>, id: String) -> Result<Vec<HistoryEntry>, String> {
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
    parent_path: Option<String>,
    confirmed: Option<bool>,
) -> Result<FolderNode, String> {
    with_workspace(state, |workspace| {
        workspace.folder_create(&name, parent_path.as_deref(), confirmed.unwrap_or(false))
    })
}

#[tauri::command]
fn folder_update(
    state: State<'_, WorkspaceState>,
    id: String,
    name: Option<String>,
    new_parent_path: Option<String>,
    confirmed: Option<bool>,
) -> Result<Vec<FolderNode>, String> {
    with_workspace(state, |workspace| {
        workspace.folder_update(&id, name, new_parent_path.as_deref(), confirmed.unwrap_or(false))
    })
}

#[tauri::command]
fn folder_delete(
    state: State<'_, WorkspaceState>,
    id: String,
    confirmed: Option<bool>,
    second_confirmed: Option<bool>,
) -> Result<Vec<FolderNode>, String> {
    with_workspace(state, |workspace| {
        workspace.folder_delete(
            &id,
            confirmed.unwrap_or(false),
            second_confirmed.unwrap_or(false),
        )
    })
}

/// 后台扫描执行器：领取 `vault-scan` 任务 → 取消检查 → 增量 reconcile →
/// 完成并广播统计。空闲时每秒轮询（单机场景足够，避免复杂唤醒机制）。
fn spawn_scan_worker(handle: tauri::AppHandle) {
    std::thread::spawn(move || loop {
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
                                .complete(&job.id, &serde_json::to_value(summary).unwrap_or_default())
                                .map(|_| ()),
                            Err(error) => workspace.jobs().fail(&job.id, &error.message).map(|_| ()),
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
            return Ok(VaultInfo {
                path: current.path().to_string_lossy().into_owned(),
            });
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

    let info = VaultInfo {
        path: next.path().to_string_lossy().into_owned(),
    };
    let mut current = state.0.write().map_err(|error| error.to_string())?;
    *current = next;
    Ok(info)
}
