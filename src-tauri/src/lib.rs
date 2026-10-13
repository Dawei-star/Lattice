//! 格物 Lattice 原生后端（Tauri 2）。
//!
//! 分层：
//! - `vault`  —— 文件系统真源：安全路径校验、原子写、哈希冲突保护；
//! - `db`     —— SQLite 索引库连接与 Schema 迁移；
//! - `index`  —— FTS5 trigram 检索与增量扫描（可随时删除重建的投影）；
//! - `time`   —— ISO-8601 UTC 时间格式化。
//!
//! Phase 1 目标（见 lattice-architecture.html）：Express 后端退场，
//! 原本跑在 Node 进程里的 SQLite / FTS5 检索改为 Rust 侧原生驱动。

mod db;
mod index;
mod time;
mod vault;

use index::{Index, IndexStats, NoteMatch, ScanSummary};
use std::path::PathBuf;
use std::sync::RwLock;
use tauri::{Manager, State};
use vault::{NoteContents, NoteFile, Vault, VaultInfo};

/// 一个工作区 = 文件系统真源 + 一份可重建的 SQLite 索引投影。
pub struct Workspace {
    vault: Vault,
    index: Index,
}

impl Workspace {
    fn open(root: PathBuf) -> Result<Self, String> {
        let vault = Vault::open(root).map_err(|error| error.to_string())?;
        let index = Index::open(vault.root())?;
        Ok(Self { vault, index })
    }

    fn path(&self) -> &std::path::Path {
        self.vault.root()
    }

    /// 写入笔记并在同一调用里刷新索引，避免「写完还要等一次全库扫描」。
    fn save(
        &self,
        path: &str,
        raw: &str,
        expected_hash: Option<&str>,
    ) -> Result<NoteContents, String> {
        let note = self.vault.write(path, raw, expected_hash)?;
        let meta = self.vault.stat(&note.path)?;
        if let Err(error) = self
            .index
            .upsert(&note.path, &note.raw, &note.sha256, meta.bytes, meta.modified_at)
        {
            // 索引是可重建的投影：同步失败不应让用户的保存失败，
            // 下一次扫描会自动修正。
            log::warn!("索引同步失败（下次扫描会自愈）：{error}");
        }
        Ok(note)
    }
}

pub struct WorkspaceState(pub RwLock<Workspace>);

/// 统一的状态访问入口：只读锁内执行动作，避免每个命令重复写锁样板。
fn with_workspace<T>(
    state: State<'_, WorkspaceState>,
    action: impl FnOnce(&Workspace) -> Result<T, String>,
) -> Result<T, String> {
    let workspace = state.0.read().map_err(|error| error.to_string())?;
    action(&workspace)
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
            app.manage(WorkspaceState(RwLock::new(Workspace::open(root)?)));
            app.handle().plugin(tauri_plugin_dialog::init())?;
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
            vault_index_stats
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
    with_workspace(state, |workspace| workspace.index.list())
}

#[tauri::command]
fn vault_read(state: State<'_, WorkspaceState>, path: String) -> Result<NoteContents, String> {
    with_workspace(state, |workspace| workspace.vault.read(&path))
}

#[tauri::command]
fn vault_write(
    state: State<'_, WorkspaceState>,
    path: String,
    raw: String,
    expected_hash: Option<String>,
) -> Result<NoteContents, String> {
    with_workspace(state, |workspace| {
        workspace.save(&path, &raw, expected_hash.as_deref())
    })
}

#[tauri::command]
fn vault_search(
    state: State<'_, WorkspaceState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<NoteMatch>, String> {
    with_workspace(state, |workspace| {
        workspace.index.search(&query, limit.unwrap_or(20))
    })
}

/// 增量对齐文件系统与索引：未变化的文件不读盘。
#[tauri::command]
fn vault_scan(state: State<'_, WorkspaceState>) -> Result<ScanSummary, String> {
    with_workspace(state, |workspace| workspace.index.scan(&workspace.vault))
}

#[tauri::command]
fn vault_index_stats(state: State<'_, WorkspaceState>) -> Result<IndexStats, String> {
    with_workspace(state, |workspace| workspace.index.stats())
}

#[tauri::command]
fn vault_read_asset(state: State<'_, WorkspaceState>, path: String) -> Result<String, String> {
    with_workspace(state, |workspace| workspace.vault.read_asset(&path))
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
    // 先完整打开（含索引库）再落盘配置，任何一步失败都不会留下半个状态。
    let next = Workspace::open(requested)?;
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
