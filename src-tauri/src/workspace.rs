//! WorkspaceService：唯一的 Vault 写入边界（升级计划 P1-01）。
//!
//! 职责（对齐 lattice-architecture §12）：
//! - 路径校验、内容哈希、原子写入（复用 `vault::Vault` 的既有保护）；
//! - 写入前版本快照：`.lattice/history/<note-id>/<YYYYMMDDTHH9Z-64hex>.md`，
//!   与 Express `notes.history.js` 完全同构，P1-04 迁移 history 命令时无缝；
//! - 审计：所有写入/冲突事件追加到 `.lattice/audit.jsonl`；
//! - 单实例锁：第二实例明确报"已被占用"，禁止静默共写（风险 R12）；
//! - 统一错误模型：`ServiceError { code, message }`，命令面在 P1-04 切换。

use crate::index::{FolderNode, Index, NoteDetail};
use crate::jobs::JobsQueue;
use crate::markdown::{normalize_title, parse_frontmatter, sanitize_file_part, serialize_markdown_document, MarkdownDocument};
use crate::time::{iso8601_utc, now_millis};
use crate::vault::{NoteContents, Vault};
use uuid::Uuid;
use fs2::FileExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 单篇笔记的历史快照上限，与 Express `notes.history.js` 一致。
pub const SNAPSHOT_LIMIT: usize = 200;

/// 统一命令错误模型：`code` 走契约枚举（见 ipc-contract.md §1），`message` 人类可读。
/// P1-04 起命令面序列化形状对齐 `{ error: { code, message } }`。
#[derive(Debug, Clone, Serialize)]
pub struct ServiceError {
    pub code: &'static str,
    pub message: String,
}

impl ServiceError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ServiceError {}

impl From<std::io::Error> for ServiceError {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO_ERROR", error.to_string())
    }
}

/// 审计日志：JSONL 逐行追加，磁盘真源之外的第二事实（数据不变量 I6）。
/// 单条审计失败只告警不阻断业务写入——审计是旁路，不是写入闸门。
pub struct AuditLog {
    path: PathBuf,
}

impl AuditLog {
    fn open(lattice_dir: &Path) -> Result<Self, ServiceError> {
        fs::create_dir_all(lattice_dir)?;
        Ok(Self { path: lattice_dir.join("audit.jsonl") })
    }

    fn record(&self, action: &str, fields: &[(&str, &str)]) {
        let mut entry = serde_json::Map::new();
        entry.insert("ts".into(), serde_json::json!(crate::time::iso8601_utc(crate::time::now_millis())));
        entry.insert("action".into(), serde_json::json!(action));
        for (key, value) in fields {
            entry.insert((*key).into(), serde_json::json!(value));
        }
        if let Ok(line) = serde_json::to_string(&entry)
            && let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&self.path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// 版本快照器：与 Express `notes.history.js` 同构的文件系统投影（不变量 I1/I6）。
pub struct SnapshotStore {
    root: PathBuf, // <Vault>/.lattice/history
}

/// 一个已存在的快照条目（版本名 = `<17位时间戳>-<sha256>`）。
pub struct SnapshotMeta {
    pub version: String,
    pub hash: String,
    pub created_at: Option<String>,
    pub size: u64,
}

impl SnapshotStore {
    fn open(lattice_dir: &Path) -> Self {
        Self { root: lattice_dir.join("history") }
    }

    /// 列出某笔记的全部快照，按版本名倒序（时间戳前缀保证字典序即时间序）。
    fn list(&self, note_id: &str) -> Vec<SnapshotMeta> {
        let mut snapshots = Vec::new();
        let Ok(entries) = fs::read_dir(self.root.join(note_id)) else {
            return snapshots;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(stripped) = name.strip_suffix(".md") else { continue };
            let Some((stamp, hash)) = stripped.split_once('-') else { continue };
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            snapshots.push(SnapshotMeta {
                version: stripped.to_owned(),
                hash: hash.to_owned(),
                created_at: version_created_at(stamp),
                size,
            });
        }
        snapshots.sort_by(|left, right| right.version.cmp(&left.version));
        snapshots
    }

    /// 读取快照原文；版本名非法或文件缺失返回 None。
    fn read(&self, note_id: &str, version: &str) -> Option<String> {
        let (stamp, hash) = valid_version(version)?;
        let path = self.root.join(note_id).join(format!("{version}.md"));
        let raw = fs::read_to_string(path).ok()?;
        // 完整性校验（对齐 assertSnapshotMatchesHash）：内容哈希必须与文件名一致
        if checksum(raw.as_bytes()) != hash {
            log::warn!("快照 {version} 已损坏（哈希不符）");
            return None;
        }
        let _ = stamp;
        Some(raw)
    }

    /// 把 `raw` 存为该笔记的新快照；内容与最新快照一致时跳过（幂等）。
    /// 返回 Some(version) 表示落盘，None 表示跳过。
    fn create(
        &self,
        note_id: &str,
        raw: &str,
        limit: usize,
    ) -> Result<Option<String>, ServiceError> {
        let limit = limit.max(1);
        let hash = checksum(raw.as_bytes());
        let existing = self.list(note_id);
        if let Some(latest) = existing.first()
            && latest.hash == hash
        {
            return Ok(None);
        }
        let directory = self.root.join(note_id);
        fs::create_dir_all(&directory)?;
        // 同毫秒同内容哈希的版本名冲突时 +1ms 重试（与 Express 一致）
        let mut timestamp = crate::time::now_millis();
        let version = loop {
            let candidate = format_version(timestamp, &hash);
            if !directory.join(format!("{candidate}.md")).exists() {
                break candidate;
            }
            timestamp += 1;
        };
        let mut file = File::create(directory.join(format!("{version}.md")))?;
        file.write_all(raw.as_bytes())?;
        file.sync_all()?;
        // 超出上限从最旧开始删除；单个删除失败不阻断
        for stale in self.list(note_id).iter().take(existing.len().saturating_sub(limit - 1)) {
            let _ = fs::remove_file(self.root.join(note_id).join(format!("{}.md", stale.version)));
        }
        Ok(Some(version))
    }
}

fn checksum(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 与 Express `formatVersion` 一致：`YYYYMMDDTHHMMSSmmmZ-<hash>`（17 位时间戳）。
fn format_version(timestamp_millis: i64, hash: &str) -> String {
    let iso = crate::time::iso8601_utc(timestamp_millis); // 2026-10-13T12:34:56.789Z
    let compact: String = iso.chars().filter(|c| c.is_ascii_digit()).collect();
    // compact = YYYYMMDDHHMMSSmmm（17 位），在日期与时间之间补 'T'、结尾补 'Z'
    let stamp = format!("{}T{}Z", &compact[..8], &compact[8..]);
    format!("{stamp}-{hash}")
}

/// Express `VERSION_PATTERN`：`<8位日期>T<9位时间>Z`。
fn valid_version(version: &str) -> Option<(&str, &str)> {
    let (stamp, hash) = version.split_once('-')?;
    let bytes = stamp.as_bytes();
    if stamp.len() != 19
        || bytes[8] != b'T'
        || !stamp.ends_with('Z')
        || !stamp.chars().filter(|c| *c != 'T' && *c != 'Z').all(|c| c.is_ascii_digit())
    {
        return None;
    }
    Some((stamp, hash))
}

/// 版本名 → ISO 时间（对齐 Express versionCreatedAt）：YYYY-MM-DDTHH:MM:SS.mmmZ。
fn version_created_at(stamp: &str) -> Option<String> {
    if stamp.len() != 19 || stamp.as_bytes()[8] != b'T' {
        return None;
    }
    let digits: String = stamp.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() != 17 {
        return None;
    }
    Some(format!(
        "{}-{}-{}T{}:{}:{}.{}Z",
        &digits[0..4],
        &digits[4..6],
        &digits[6..8],
        &digits[8..10],
        &digits[10..12],
        &digits[12..14],
        &digits[14..17]
    ))
}

/// 从 Markdown frontmatter 读取笔记 id（对齐 Express NOTE_ID_PATTERN；无 id 返回 None）。
fn frontmatter_id(raw: &str) -> Option<String> {
    parse_frontmatter(raw).and_then(|meta| meta.id)
}

impl std::fmt::Debug for WorkspaceService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceService")
            .field("root", &self.vault.root().display().to_string())
            .finish_non_exhaustive()
    }
}

/// 工作区 = 单实例锁 + 文件真源 + 索引投影 + 审计 + 快照 + 任务队列。
pub struct WorkspaceService {
    vault: Vault,
    index: Index,
    audit: AuditLog,
    snapshots: SnapshotStore,
    jobs: JobsQueue,
    _lock: File, // 句柄存活期间锁有效；drop 即释放
}

impl WorkspaceService {
    /// 打开工作区：先取单实例锁，再挂载 vault 与索引。
    /// 第二实例收到 `VAULT_LOCKED`，绝不静默共写。
    pub fn open(root: PathBuf) -> Result<Self, ServiceError> {
        let lattice_dir = root.join(".lattice");
        fs::create_dir_all(&lattice_dir)?;
        let lock_path = lattice_dir.join("workspace.lock");
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)?;
        lock.try_lock_exclusive().map_err(|_| {
            ServiceError::new(
                "VAULT_LOCKED",
                format!("Vault 已被另一个 Lattice 实例占用：{}", root.display()),
            )
        })?;
        let vault =
            Vault::open(root).map_err(|error| ServiceError::new("VAULT_OPEN_FAILED", error.to_string()))?;
        let index = Index::open(vault.root())
            .map_err(|error| ServiceError::new("INDEX_OPEN_FAILED", error))?;
        let audit = AuditLog::open(&lattice_dir)?;
        let jobs = JobsQueue::open(lattice_dir.join("lattice.db").as_path())
            .map_err(|error| ServiceError::new("JOBS_OPEN_FAILED", error))?;
        let recovered = jobs.recover_interrupted().unwrap_or(0);
        if recovered > 0 {
            log::info!("启动恢复：{recovered} 个中断任务已重排回队列");
        }
        audit.record("workspace_open", &[("path", &vault.root().to_string_lossy())]);
        Ok(Self {
            vault,
            index,
            audit,
            snapshots: SnapshotStore::open(&lattice_dir),
            jobs,
            _lock: lock,
        })
    }

    /// 统一写入入口：哈希冲突保护 → 原子落盘 → 旧内容快照 → 审计 → 索引同步。
    pub fn write(
        &self,
        path: &str,
        raw: &str,
        expected_hash: Option<&str>,
        actor: &str,
    ) -> Result<NoteContents, ServiceError> {
        // 快照需要旧内容；读取失败（不存在/超限）不阻断写入
        let previous = self.vault.read(path).ok();
        let note = self.vault.write(path, raw, expected_hash).map_err(|error| {
            let code = if error.contains("changed on disk") || error.contains("removed before") {
                "CONFLICT"
            } else {
                "WRITE_FAILED"
            };
            self.audit.record("write_rejected", &[("path", path), ("code", code), ("actor", actor)]);
            ServiceError::new(code, error)
        })?;
        // 旧内容与最新快照一致时 create 内部会跳过；无 frontmatter id 的文件跳过快照
        if let Some(previous) = previous {
            match frontmatter_id(&previous.raw) {
                Some(note_id) => match self.snapshots.create(&note_id, &previous.raw, SNAPSHOT_LIMIT) {
                    Ok(Some(version)) => {
                        self.audit.record("snapshot", &[("path", path), ("version", &version), ("actor", actor)]);
                    }
                    Ok(None) => {}
                    Err(error) => log::warn!("快照失败（不阻断写入）：{error}"),
                },
                None => log::debug!("跳过快照：{path} 缺少合法的 frontmatter id"),
            }
        }
        self.audit.record("write", &[("path", path), ("hash", &note.sha256), ("actor", actor)]);
        // 索引是可重建投影：同步失败只告警，下次扫描自愈
        if let Ok(meta) = self.vault.stat(&note.path)
            && let Err(error) = self.index.upsert(&note.path, &note.raw, &note.sha256, meta.bytes, meta.modified_at)
        {
            log::warn!("索引同步失败（下次扫描会自愈）：{error}");
        }
        Ok(note)
    }

    /// 当前 Vault 是否为指定路径（vault_open 重开同一 Vault 时走幂等分支）。
    pub fn is_same_root(&self, root: &Path) -> bool {
        self.vault.root() == root
    }

    pub fn path(&self) -> &Path {
        self.vault.root()
    }

    pub fn vault(&self) -> &Vault {
        &self.vault
    }

    pub fn index(&self) -> &Index {
        &self.index
    }

    pub fn jobs(&self) -> &JobsQueue {
        &self.jobs
    }

    /// 创建笔记（契约 POST /api/notes → note_create）：
    /// confirmed 必需；client id 已存在时幂等返回详情；标题归一化 + 路径占用
    /// 递增分配；frontmatter 序列化后经统一写边界落盘（审计/快照/索引一并生效）。
    pub fn create_note(
        &self,
        id: Option<String>,
        title: Option<String>,
        content: &str,
        properties: &serde_json::Map<String, serde_json::Value>,
        confirmed: bool,
    ) -> Result<NoteDetail, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "创建笔记需要 confirmed=true",
            ));
        }
        if let Some(id) = id.as_deref()
            && let Some(existing) = self
                .index
                .find_note_detail(Some(id), None)
                .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
        {
            return Ok(existing); // 幂等：同 id 重复创建直接返回
        }
        let note_id = match id {
            Some(id) => id,
            None => Uuid::new_v4().to_string(),
        };
        let final_title = normalize_title(title.as_deref().unwrap_or(""), content);
        let file_path = self.allocate_file_path(&final_title)?;
        let timestamp = iso8601_utc(now_millis());
        let raw = serialize_markdown_document(&MarkdownDocument {
            id: &note_id,
            title: &final_title,
            content,
            is_pinned: false,
            created_at: &timestamp,
            updated_at: &timestamp,
            properties,
        });
        self.write(&file_path, &raw, None, "ui")?;
        self.index
            .find_note_detail(None, Some(&file_path))
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            .ok_or_else(|| ServiceError::new("NOTES_ERROR", "创建后索引未同步，请重试"))
    }

    /// 路径分配（对齐 allocateFilePath）：重名时追加 " (2)" 递增后缀。
    fn allocate_file_path(&self, title: &str) -> Result<String, ServiceError> {
        let base = format!("{}.md", sanitize_file_part(title, "未命名笔记"));
        let stem = base.trim_end_matches(".md").to_owned();
        let mut candidate = base.clone();
        let mut suffix = 2;
        loop {
            let taken_in_index = self
                .index
                .is_path_taken(&candidate)
                .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
            let taken_on_disk = self.vault.root().join(&candidate).exists();
            if !taken_in_index && !taken_on_disk {
                return Ok(candidate);
            }
            candidate = format!("{stem} ({suffix}).md");
            suffix += 1;
        }
    }

    /// 更新笔记（契约 PATCH /api/notes/:id → note_update）：
    /// expectedHash 乐观锁（409）；标题变更触发路径重分配与原子 rename；
    /// 快照/审计/索引同步由统一写边界自动完成。folderId 随第三批迁移（Δ2）。
    #[allow(clippy::too_many_arguments)]
    pub fn update_note(
        &self,
        id: &str,
        title: Option<String>,
        content: Option<String>,
        is_pinned: Option<bool>,
        properties: Option<serde_json::Map<String, serde_json::Value>>,
        expected_hash: Option<String>,
        confirmed: bool,
    ) -> Result<NoteDetail, ServiceError> {
        let current = self
            .index
            .find_note_detail(Some(id), None)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "笔记不存在"))?;
        // 乐观锁：客户端携带 expectedHash 时校验（I2）
        if let Some(expected) = expected_hash.as_deref()
            && let Some(current_hash) = current.content_hash.as_deref()
            && expected != current_hash
        {
            self.audit.record("update_rejected", &[("path", id), ("code", "CONFLICT"), ("actor", "ui")]);
            return Err(ServiceError::new(
                "CONFLICT",
                "笔记已在其他窗口被修改，请刷新后再保存",
            ));
        }
        // 改 content/置顶免确认；会改变文件路径的（标题）需要 confirmed（契约特例）
        let title_changed = title.as_ref().is_some_and(|next| *next != current.title);
        if title_changed && !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "修改标题会改变文件路径，需要 confirmed=true",
            ));
        }
        let old_path = current
            .file_path
            .clone()
            .ok_or_else(|| ServiceError::new("NOTES_ERROR", "笔记缺少文件路径"))?;
        let next_title = title.unwrap_or_else(|| current.title.clone());
        let next_content = content.unwrap_or_else(|| current.content.clone());
        let next_pinned = is_pinned.unwrap_or(current.is_pinned);
        let next_properties = properties.unwrap_or_default();

        let content_changed = next_content != current.content;
        let pinned_changed = next_pinned != current.is_pinned;
        let properties_changed = {
            let current_properties: serde_json::Value = current
                .properties_json
                .as_deref()
                .and_then(|text| serde_json::from_str(text).ok())
                .unwrap_or(serde_json::Value::Null);
            serde_json::Value::Object(next_properties.clone()) != current_properties
        };
        let path_changed = title_changed;
        if !title_changed && !content_changed && !pinned_changed && !properties_changed {
            return Ok(current); // 无变化短路
        }
        let next_path = if path_changed {
            self.allocate_file_path(&next_title)?
        } else {
            old_path.clone()
        };
        let updated_at = iso8601_utc(now_millis());
        let raw = serialize_markdown_document(&MarkdownDocument {
            id,
            title: &next_title,
            content: &next_content,
            is_pinned: next_pinned,
            created_at: current.created_at.as_deref().unwrap_or(&updated_at),
            updated_at: &updated_at,
            properties: &next_properties,
        });
        if path_changed {
            // 重命名：新内容写旧路径（触发旧内容快照）→ 原子 rename → 投影迁移。
            // Windows 上文件被占用时 rename 明确失败并整体回滚（Express 同语义）。
            self.write(&old_path, &raw, None, "ui")?;
            let mut moved = false;
            let mut last_error = None;
            for _ in 0..3 {
                match std::fs::rename(self.vault.root().join(&old_path), self.vault.root().join(&next_path)) {
                    Ok(()) => {
                        moved = true;
                        break;
                    }
                    Err(error) => {
                        last_error = Some(error);
                        std::thread::sleep(std::time::Duration::from_millis(80));
                    }
                }
            }
            if !moved {
                return Err(ServiceError::new(
                    "CONFLICT",
                    format!(
                        "文件正被其他程序占用，无法重命名（{}）",
                        last_error.map(|error| error.to_string()).unwrap_or_else(|| "未知错误".into())
                    ),
                ));
            }
            self.index
                .remove(&old_path)
                .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
            let meta = self
                .vault
                .stat(&next_path)
                .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
            self.index
                .upsert(&next_path, &raw, &meta_sha256(&raw), meta.bytes, meta.modified_at)
                .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
            self.audit.record("rename", &[("from", &old_path), ("to", &next_path), ("actor", "ui")]);
        } else {
            // 同路径内容更新：expectedHash 用 current.contentHash（乐观锁已校验）
            self.write(&old_path, &raw, current.content_hash.as_deref(), "ui")?;
        }
        self.index
            .find_note_detail(Some(id), None)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            .ok_or_else(|| ServiceError::new("NOTES_ERROR", "更新后索引未同步，请重试"))
    }

    /// 删除笔记（契约 DELETE /api/notes/:id → note_delete）：
    /// destructive——confirmed + secondConfirmed 双确认；删除文件与投影行，
    /// 历史快照目录保留（版本快照是附属数据，不随删除丢失）。
    pub fn delete_note(&self, id: &str, confirmed: bool, second_confirmed: bool) -> Result<bool, ServiceError> {
        if !confirmed || !second_confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "删除笔记需要 confirmed=true 且 secondConfirmed=true",
            ));
        }
        let current = self
            .index
            .find_note_detail(Some(id), None)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "笔记不存在"))?;
        let path = current
            .file_path
            .ok_or_else(|| ServiceError::new("NOTES_ERROR", "笔记缺少文件路径"))?;
        std::fs::remove_file(self.vault.root().join(&path))
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法删除文件：{error}")))?;
        self.index
            .remove(&path)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
        self.audit.record("delete", &[("path", &path), ("actor", "ui")]);
        Ok(true)
    }

    /// 历史版本列表（契约 GET /api/notes/:id/history → note_history_list）。
    pub fn history_list(&self, id: &str) -> Result<Vec<HistoryEntry>, ServiceError> {
        let note_id = self.require_note_id(id)?;
        Ok(self
            .snapshots
            .list(&note_id)
            .into_iter()
            .map(|meta| HistoryEntry {
                version: meta.version,
                hash: meta.hash,
                created_at: meta.created_at,
                size: meta.size,
            })
            .collect())
    }

    /// 读取历史版本内容（契约 GET /api/notes/:id/history/:version → note_history_get）。
    pub fn history_get(&self, id: &str, version: &str) -> Result<HistorySnapshot, ServiceError> {
        let note_id = self.require_note_id(id)?;
        let raw = self
            .snapshots
            .read(&note_id, version)
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "历史版本不存在或已损坏"))?;
        let (_, hash) = valid_version(version)
            .ok_or_else(|| ServiceError::new("VALIDATION", "历史版本标识无效"))?;
        Ok(HistorySnapshot {
            version: version.to_owned(),
            raw,
            hash: hash.to_owned(),
        })
    }

    /// 恢复历史版本（契约 POST /api/notes/:id/history/:version/restore →
    /// note_history_restore）：快照原文整体重写当前文件（走统一写边界，
    /// 恢复前的内容自动进入快照），expectedCurrentHash 提供时校验乐观锁。
    pub fn history_restore(
        &self,
        id: &str,
        version: &str,
        expected_current_hash: Option<String>,
        confirmed: bool,
    ) -> Result<NoteDetail, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "恢复历史版本需要 confirmed=true",
            ));
        }
        let current = self
            .index
            .find_note_detail(Some(id), None)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "笔记不存在"))?;
        if let Some(expected) = expected_current_hash.as_deref()
            && let Some(current_hash) = current.content_hash.as_deref()
            && expected != current_hash
        {
            return Err(ServiceError::new(
                "CONFLICT",
                "笔记已在其他窗口被修改，请刷新后再保存",
            ));
        }
        let snapshot = self.history_get(id, version)?;
        let path = current
            .file_path
            .clone()
            .ok_or_else(|| ServiceError::new("NOTES_ERROR", "笔记缺少文件路径"))?;
        self.write(&path, &snapshot.raw, current.content_hash.as_deref(), "ui")?;
        self.audit.record("restore", &[("path", &path), ("version", version), ("actor", "ui")]);
        self.index
            .find_note_detail(Some(id), None)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            .ok_or_else(|| ServiceError::new("NOTES_ERROR", "恢复后索引未同步，请重试"))
    }

    /// 定位笔记的 frontmatter id（历史快照按 UUID 组织；无 id 的笔记无历史）。
    fn require_note_id(&self, id: &str) -> Result<String, ServiceError> {
        let detail = self
            .index
            .find_note_detail(Some(id), None)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "笔记不存在"))?;
        let path = detail
            .file_path
            .clone()
            .ok_or_else(|| ServiceError::new("NOTES_ERROR", "笔记缺少文件路径"))?;
        let raw = self
            .vault
            .read(&path)
            .map_err(|error| ServiceError::new("READ_ERROR", error))?;
        frontmatter_id(&raw.raw)
            .ok_or_else(|| ServiceError::new("VALIDATION", "笔记缺少 frontmatter id，无历史记录"))
    }

    /// 创建目录（契约 POST /api/folders → folder_create）：
    /// 磁盘目录为真源（多层父目录自动创建）；同级同名视为冲突。
    pub fn folder_create(
        &self,
        name: &str,
        parent_path: Option<&str>,
        confirmed: bool,
    ) -> Result<FolderNode, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "创建目录需要 confirmed=true",
            ));
        }
        let safe_name = sanitize_file_part(name, "未命名目录");
        let relative = match parent_path {
            Some(parent) => format!("{parent}/{safe_name}"),
            None => safe_name.clone(),
        };
        let target = self.vault.root().join(&relative);
        if target.exists() {
            return Err(ServiceError::new(
                "CONFLICT",
                format!("同级下已存在名为「{safe_name}」的目录"),
            ));
        }
        std::fs::create_dir_all(&target)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法创建目录：{error}")))?;
        self.audit.record("folder_create", &[("path", &relative), ("actor", "ui")]);
        Ok(FolderNode {
            id: crate::index::stable_folder_id(&relative),
            name: safe_name,
            parent_id: parent_path.map(crate::index::stable_folder_id),
            sort_order: 0,
            note_count: 0,
            children: Vec::new(),
        })
    }

    /// 目录重命名/移动（契约 PATCH /api/folders/:id → folder_update）：
    /// 磁盘 rename 一次完成子树移动，投影由全量扫描自愈（笔记/链接/标签级联）。
    pub fn folder_update(
        &self,
        id: &str,
        name: Option<String>,
        new_parent_path: Option<&str>,
        confirmed: bool,
    ) -> Result<Vec<FolderNode>, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "修改目录需要 confirmed=true（会改变其下笔记路径）",
            ));
        }
        let old_path = crate::index::directory_path_for_id(&self.vault, id)
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "目录不存在"))?;
        let old_name = old_path.rsplit('/').next().unwrap_or(&old_path).to_owned();
        let parent = old_path.rsplit_once('/').map(|(parent, _)| parent.to_owned());
        let next_name = match name.as_deref() {
            Some(next) => sanitize_file_part(next, "未命名目录"),
            None => old_name,
        };
        let next_parent = new_parent_path.map(str::to_owned).unwrap_or(parent.clone().unwrap_or_default());
        let parent = if new_parent_path.is_some() { Some(next_parent.clone()) } else { parent };
        let next_path = match parent {
            Some(parent) if !parent.is_empty() => format!("{parent}/{next_name}"),
            _ => next_name.clone(),
        };
        if next_path == old_path {
            return self
                .index
                .folder_tree(&self.vault)
                .map_err(|error| ServiceError::new("FOLDERS_ERROR", error));
        }
        let target = self.vault.root().join(&next_path);
        if target.exists() {
            return Err(ServiceError::new(
                "CONFLICT",
                format!("目标位置已存在「{next_name}」"),
            ));
        }
        std::fs::rename(self.vault.root().join(&old_path), target)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法重命名目录：{error}")))?;
        self.audit.record("folder_rename", &[("from", &old_path), ("to", &next_path), ("actor", "ui")]);
        // 投影自愈：路径变化级联 notes.folder_id / links / note_tags
        self.index
            .scan(&self.vault)
            .map_err(|error| ServiceError::new("SCAN_ERROR", error))?;
        self.index
            .folder_tree(&self.vault)
            .map_err(|error| ServiceError::new("FOLDERS_ERROR", error))
    }

    /// 删除空目录（契约 DELETE /api/folders/:id → folder_delete）：
    /// destructive 双确认；含笔记或子目录时明确拒绝（不级联删除用户数据）。
    pub fn folder_delete(
        &self,
        id: &str,
        confirmed: bool,
        second_confirmed: bool,
    ) -> Result<Vec<FolderNode>, ServiceError> {
        if !confirmed || !second_confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "删除目录需要 confirmed=true 且 secondConfirmed=true",
            ));
        }
        let path = crate::index::directory_path_for_id(&self.vault, id)
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "目录不存在"))?;
        let target = self.vault.root().join(&path);
        let mut entries = std::fs::read_dir(&target)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法读取目录：{error}")))?;
        if entries.next().is_some() {
            return Err(ServiceError::new(
                "CONFLICT",
                "目录不为空：请先移走其中的笔记与子目录",
            ));
        }
        std::fs::remove_dir(&target)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法删除目录：{error}")))?;
        self.audit.record("folder_delete", &[("path", &path), ("actor", "ui")]);
        self.index
            .folder_tree(&self.vault)
            .map_err(|error| ServiceError::new("FOLDERS_ERROR", error))
    }
}

/// 画布安全路径校验：必须 .canvas 后缀、禁止路径穿越与内部目录。
impl WorkspaceService {
    fn canvas_path(&self, relative: &str) -> Result<PathBuf, ServiceError> {
        let trimmed = relative.trim().replace('\\', "/");
        if trimmed.is_empty()
            || trimmed.starts_with('/')
            || trimmed
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || trimmed
                .split('/')
                .next()
                .is_some_and(|first| first.eq_ignore_ascii_case(".lattice"))
        {
            return Err(ServiceError::new("VALIDATION", "非法的画布路径"));
        }
        if !trimmed.to_ascii_lowercase().ends_with(".canvas") {
            return Err(ServiceError::new("VALIDATION", "画布文件必须是 .canvas 后缀"));
        }
        Ok(self.vault.root().join(trimmed))
    }

    /// 画布文件列表（契约 GET /api/canvas/files → canvas_list）。
    pub fn canvas_list(&self) -> Result<Vec<String>, ServiceError> {
        let mut files = Vec::new();
        fn walk(root: &Path, prefix: &str, files: &mut Vec<String>) {
            let Ok(entries) = std::fs::read_dir(root) else { return };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if name.eq_ignore_ascii_case(".lattice") {
                        continue;
                    }
                    walk(&entry.path(), &relative, files);
                } else if name.to_ascii_lowercase().ends_with(".canvas") {
                    files.push(relative);
                }
            }
        }
        walk(self.vault.root(), "", &mut files);
        files.sort();
        Ok(files)
    }

    /// 读取画布（契约 GET /api/canvas → canvas_read）：缺失返回空画布，
    /// revision 为原文哈希（乐观锁基准），与 Express read 语义一致。
    pub fn canvas_read(&self, path: &str) -> Result<CanvasDocument, ServiceError> {
        let file = self.canvas_path(path)?;
        match std::fs::read_to_string(&file) {
            Ok(raw) => {
                let value: serde_json::Value = serde_json::from_str(&raw)
                    .map_err(|error| ServiceError::new("VALIDATION", format!("画布 JSON 解析失败：{error}")))?;
                Ok(CanvasDocument {
                    nodes: value.get("nodes").cloned().unwrap_or(serde_json::Value::Array(Vec::new())),
                    edges: value.get("edges").cloned().unwrap_or(serde_json::Value::Array(Vec::new())),
                    revision: Some(checksum(raw.as_bytes())),
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(CanvasDocument {
                nodes: serde_json::Value::Array(Vec::new()),
                edges: serde_json::Value::Array(Vec::new()),
                revision: None,
            }),
            Err(error) => Err(ServiceError::new("IO_ERROR", error.to_string())),
        }
    }

    /// 写入画布（契约 PUT /api/canvas → canvas_write）：
    /// 新建需要 confirmed；已有文件走 expectedHash 乐观锁（409）。
    pub fn canvas_write(
        &self,
        path: &str,
        nodes: serde_json::Value,
        edges: serde_json::Value,
        expected_hash: Option<&str>,
        confirmed: bool,
    ) -> Result<String, ServiceError> {
        let file = self.canvas_path(path)?;
        let exists = file.exists();
        if !exists && !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "新建画布需要 confirmed=true",
            ));
        }
        let raw = serde_json::to_string_pretty(&serde_json::json!({ "nodes": nodes, "edges": edges }))
            .map_err(|error| ServiceError::new("VALIDATION", format!("画布序列化失败：{error}")))?;
        if exists {
            let current_raw = std::fs::read_to_string(&file)
                .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
            let current_hash = checksum(current_raw.as_bytes());
            if let Some(expected) = expected_hash
                && expected != current_hash
            {
                return Err(ServiceError::new(
                    "CONFLICT",
                    "画布已在其他窗口被修改，请刷新后再保存",
                ));
            }
            let mut temporary = tempfile::NamedTempFile::new_in(
                file.parent().ok_or_else(|| ServiceError::new("IO_ERROR", "无效路径"))?,
            )
            .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
            use std::io::Write;
            temporary
                .write_all(raw.as_bytes())
                .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
            temporary
                .persist(&file)
                .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
        } else {
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent)?;
            }
            std::fs::write(&file, &raw).map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
        }
        self.audit.record("canvas_write", &[("path", path), ("actor", "ui")]);
        Ok(checksum(raw.as_bytes()))
    }

    /// 移动/重命名画布（契约 PATCH /api/canvas/file → canvas_move）。
    pub fn canvas_move(&self, from: &str, to: &str, confirmed: bool) -> Result<bool, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new("CONFIRMATION_REQUIRED", "移动画布需要 confirmed=true"));
        }
        let source = self.canvas_path(from)?;
        let target = self.canvas_path(to)?;
        if !source.exists() {
            return Err(ServiceError::new("NOT_FOUND", "画布不存在"));
        }
        if target.exists() {
            return Err(ServiceError::new("CONFLICT", "目标画布已存在"));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        std::fs::rename(&source, &target)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法移动画布：{error}")))?;
        self.audit.record("canvas_move", &[("from", from), ("to", to), ("actor", "ui")]);
        Ok(true)
    }

    /// 删除画布（契约 DELETE /api/canvas/file → canvas_delete）：destructive 双确认。
    pub fn canvas_delete(&self, path: &str, confirmed: bool, second_confirmed: bool) -> Result<bool, ServiceError> {
        if !confirmed || !second_confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "删除画布需要 confirmed=true 且 secondConfirmed=true",
            ));
        }
        let file = self.canvas_path(path)?;
        if !file.exists() {
            return Err(ServiceError::new("NOT_FOUND", "画布不存在"));
        }
        std::fs::remove_file(&file)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法删除画布：{error}")))?;
        self.audit.record("canvas_delete", &[("path", path), ("actor", "ui")]);
        Ok(true)
    }
}

/// 附件管理（契约 vault/attachments 组）。附件固定存于 `<Vault>/attachments/`，
/// 磁盘为真源；引用关系由笔记正文派生（可重建投影，I1）。
impl WorkspaceService {
    const ATTACHMENT_ROOT: &'static str = "attachments";

    /// 附件路径安全校验：必须位于 attachments/ 下，拒绝穿越与内部目录。
    fn attachment_path(&self, relative: &str) -> Result<PathBuf, ServiceError> {
        let trimmed = relative.trim().replace('\\', "/");
        if !trimmed.starts_with("attachments/")
            || trimmed
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(ServiceError::new("VALIDATION", "附件路径必须位于 attachments/ 下"));
        }
        Ok(self.vault.root().join(trimmed))
    }

    /// 附件 MIME 白名单（对齐 Express MIME_BY_EXTENSION 的常见子集）。
    fn attachment_mime(extension: &str) -> Option<&'static str> {
        match extension {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            "svg" => Some("image/svg+xml"),
            "pdf" => Some("application/pdf"),
            "mp4" | "webm" | "mov" => Some("video/*"),
            "mp3" | "wav" | "m4a" | "ogg" => Some("audio/*"),
            "zip" => Some("application/zip"),
            "txt" | "md" => Some("text/plain"),
            _ => None,
        }
    }

    /// 遍历附件目录，返回相对路径（含 attachments/ 前缀）。
    fn walk_attachments(&self) -> Vec<String> {
        let mut files = Vec::new();
        fn walk(dir: &Path, prefix: &str, files: &mut Vec<String>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || name.ends_with(".tmp") {
                    continue;
                }
                let relative = format!("{prefix}/{name}");
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    walk(&entry.path(), &relative, files);
                } else if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    files.push(relative);
                }
            }
        }
        walk(&self.vault.root().join(Self::ATTACHMENT_ROOT), Self::ATTACHMENT_ROOT, &mut files);
        files.sort();
        files
    }

    /// 附件列表（契约 GET /api/vault/attachments → vault_attachments_list）：
    /// 文件 + 引用来源 + orphan 标记（引用派生自笔记正文）。
    pub fn attachments_list(&self) -> Result<Vec<AttachmentEntry>, ServiceError> {
        let references = self.collect_reference_map().map_err(|error| ServiceError::new("REFERENCES_ERROR", error))?;
        let mut entries = Vec::new();
        for path in self.walk_attachments() {
            let metadata = std::fs::metadata(self.vault.root().join(&path))
                .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
            let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            let referenced_by = references.get(&path).cloned().unwrap_or_default();
            let orphan = referenced_by.is_empty();
            entries.push(AttachmentEntry {
                path: path.clone(),
                name: path.rsplit('/').next().unwrap_or(&path).to_owned(),
                size: metadata.len(),
                mime: Self::attachment_mime(&extension).unwrap_or("application/octet-stream").to_owned(),
                referenced_by,
                orphan,
            });
        }
        Ok(entries)
    }

    /// 上传附件（契约 POST /api/vault/attachments → vault_attachment_upload）：
    /// ≤25MB、MIME 白名单、confirmed 闸门、原子写。
    pub fn attachment_upload(
        &self,
        name: &str,
        bytes: Vec<u8>,
        confirmed: bool,
    ) -> Result<String, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new("CONFIRMATION_REQUIRED", "上传附件需要 confirmed=true"));
        }
        if bytes.len() as u64 > 25 * 1024 * 1024 {
            return Err(ServiceError::new("VALIDATION", "附件超过 25MB 上传限制"));
        }
        let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if Self::attachment_mime(&extension).is_none() {
            return Err(ServiceError::new("VALIDATION", format!("不支持的附件格式：{extension}")));
        }
        let safe_name = sanitize_file_part(name, "attachment");
        let relative = format!("{}/{}", Self::ATTACHMENT_ROOT, safe_name);
        let target = self.attachment_path(&relative)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, &bytes)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法写入附件：{error}")))?;
        self.audit.record("attachment_upload", &[("path", &relative), ("actor", "ui")]);
        Ok(relative)
    }

    /// 删除附件（契约 DELETE /api/vault/attachments → vault_attachment_delete）：
    /// destructive 双确认；仍被引用时明确拒绝，防止静默丢引用。
    pub fn attachment_delete(
        &self,
        path: &str,
        confirmed: bool,
        second_confirmed: bool,
    ) -> Result<bool, ServiceError> {
        if !confirmed || !second_confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "删除附件需要 confirmed=true 且 secondConfirmed=true",
            ));
        }
        let references = self.collect_reference_map().map_err(|error| ServiceError::new("REFERENCES_ERROR", error))?;
        if let Some(referenced_by) = references.get(path.trim().replace('\\', "/").as_str())
            && !referenced_by.is_empty()
        {
            return Err(ServiceError::new(
                "CONFLICT",
                format!("附件仍被 {} 篇笔记引用，请先移除引用", referenced_by.len()),
            ));
        }
        let file = self.attachment_path(path)?;
        if !file.exists() {
            return Err(ServiceError::new("NOT_FOUND", "附件不存在"));
        }
        std::fs::remove_file(&file)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法删除附件：{error}")))?;
        self.audit.record("attachment_delete", &[("path", path), ("actor", "ui")]);
        Ok(true)
    }

    /// 附件引用详情（契约 GET /api/vault/attachments/references → vault_attachment_references）。
    pub fn attachment_references(&self, path: &str) -> Result<AttachmentReferences, ServiceError> {
        let safe_path = path.trim().replace('\\', "/");
        let references = self.collect_reference_map().map_err(|error| ServiceError::new("REFERENCES_ERROR", error))?;
        let referenced_by = references.get(&safe_path).cloned().unwrap_or_default();
        Ok(AttachmentReferences {
            path: safe_path,
            referenced: !referenced_by.is_empty(),
            referenced_by,
        })
    }

    /// 全库文件列表（契约 GET /api/vault/files → vault_files_list）：
    /// 遍历整个 Vault，排除笔记扩展名（.md/.markdown/.canvas）、点开头目录/文件、
    /// .tmp 文件与 node_modules（对齐 Express walkVaultFiles / isVisibleVaultPath）。
    /// 排序用码点序（Express 为 zh-CN locale 序，差异仅影响中文混排次序，见执行日志）。
    pub fn vault_files_list(&self) -> Result<Vec<VaultFileEntry>, ServiceError> {
        let mut entries = Vec::new();
        let root = self.vault.root().to_path_buf();
        walk_vault_files(&root, &root, &mut entries);
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(entries)
    }

    /// 附件引用校验（契约 POST /api/vault/attachments/validate → vault_attachment_validate）：
    /// 从给定正文中抽取附件引用，并标出磁盘上不存在的附件（missing）。
    pub fn attachment_validate(
        &self,
        content: &str,
        file_path: &str,
    ) -> Result<AttachmentValidation, ServiceError> {
        if content.chars().count() > 2_000_000 {
            return Err(ServiceError::new("VALIDATION", "正文长度超过 200 万字符上限"));
        }
        if file_path.chars().count() > 1024 {
            return Err(ServiceError::new("VALIDATION", "文件路径超过 1024 字符上限"));
        }
        let references = self.extract_attachment_references(content, file_path);
        let existing: std::collections::HashSet<String> = self
            .list_attachment_files()
            .into_iter()
            .map(|file| file.path)
            .collect();
        let missing = references
            .iter()
            .filter(|reference| !existing.contains(*reference))
            .cloned()
            .collect();
        Ok(AttachmentValidation { references, missing })
    }

    /// 孤儿附件清理（契约 POST /api/vault/attachments/cleanup → vault_attachment_cleanup）：
    /// dryRun=true 只列出候选；真删需要 confirmed+secondConfirmed 双确认（destructive）。
    /// 单个文件删除失败不中断整批（记录进 skipped），对齐 Express cleanupOrphans。
    pub fn attachment_cleanup(
        &self,
        dry_run: bool,
        confirmed: bool,
        second_confirmed: bool,
    ) -> Result<AttachmentCleanup, ServiceError> {
        if !dry_run && !(confirmed && second_confirmed) {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "清理附件需要 confirmed=true 且 secondConfirmed=true",
            ));
        }
        let files = self.list_attachment_files();
        let references = self
            .collect_reference_map()
            .map_err(|error| ServiceError::new("REFERENCES_ERROR", error))?;
        let candidates: Vec<VaultFileEntry> = files
            .into_iter()
            .filter(|file| !references.contains_key(&file.path))
            .collect();
        if dry_run {
            return Ok(AttachmentCleanup {
                dry_run: true,
                candidates,
                deleted: Vec::new(),
                skipped: Vec::new(),
            });
        }
        let mut deleted = Vec::new();
        let mut skipped = Vec::new();
        for candidate in candidates {
            let referenced_by = references.get(&candidate.path).cloned().unwrap_or_default();
            if !referenced_by.is_empty() {
                skipped.push(CleanupSkipped {
                    file: candidate,
                    error: None,
                    referenced_by: Some(referenced_by),
                });
                continue;
            }
            let target = self.vault.root().join(&candidate.path);
            match remove_file_with_retry(&target) {
                Ok(()) => {
                    if let Some(index) = candidate.path.rfind('/') {
                        self.remove_empty_parents(&candidate.path[..index]);
                    }
                    deleted.push(candidate.path.clone());
                }
                Err(error) => skipped.push(CleanupSkipped {
                    file: candidate,
                    error: Some(error.to_string()),
                    referenced_by: None,
                }),
            }
        }
        self.audit.record(
            "attachment_cleanup",
            &[("deleted", &deleted.len().to_string()), ("skipped", &skipped.len().to_string())],
        );
        Ok(AttachmentCleanup {
            dry_run: false,
            candidates: Vec::new(),
            deleted,
            skipped,
        })
    }

    /// 任意 Vault 文件下载（契约 GET /api/vault/download → vault_download）：
    /// 评估结论：既有 vault_read_asset 只覆盖 attachments/ 下 4 种图片的 data-URL，
    /// 无法承载「任意可见非笔记文件」的下载语义，故新增本命令（见执行日志批次6）。
    /// 返回 base64 负载，前端在 P1-05~07 迁移时组装 Blob 落地。
    pub fn vault_download(&self, path: &str) -> Result<VaultDownload, ServiceError> {
        let safe_path = path.trim().replace('\\', "/");
        if safe_path.is_empty() || safe_path.chars().count() > 1024 {
            return Err(ServiceError::new("VALIDATION", "文件路径必须是 Vault 内的相对路径"));
        }
        if safe_path.starts_with('/')
            || safe_path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(ServiceError::new("VALIDATION", "文件路径必须是 Vault 内的相对路径"));
        }
        if !is_visible_vault_path(&safe_path) {
            return Err(ServiceError::new("VALIDATION", "只能下载显示列表中的附件文件"));
        }
        let target = self.vault.root().join(&safe_path);
        let metadata = std::fs::metadata(&target)
            .map_err(|_| ServiceError::new("NOT_FOUND", "文件不存在"))?;
        if !metadata.is_file() {
            return Err(ServiceError::new("NOT_FOUND", "文件不存在"));
        }
        let bytes = std::fs::read(&target)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法读取文件：{error}")))?;
        let extension = posix_extname(&safe_path).trim_start_matches('.').to_ascii_lowercase();
        Ok(VaultDownload {
            path: safe_path.clone(),
            name: safe_path.rsplit('/').next().unwrap_or(&safe_path).to_owned(),
            mime_type: vault_file_mime(&extension).map(str::to_owned),
            size: metadata.len(),
            base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes),
        })
    }

    /// 附件目录内「受支持格式」的文件清单（对齐 Express listAttachmentFiles：
    /// 只含 MIME_BY_EXTENSION 白名单内的扩展名，校验/清理共用）。
    fn list_attachment_files(&self) -> Vec<VaultFileEntry> {
        let mut files = Vec::new();
        for path in self.walk_attachments() {
            let extension = posix_extname(&path).trim_start_matches('.').to_ascii_lowercase();
            let Some(mime) = vault_file_mime(&extension) else { continue };
            let Ok(metadata) = std::fs::metadata(self.vault.root().join(&path)) else { continue };
            files.push(VaultFileEntry {
                name: path.rsplit('/').next().unwrap_or(&path).to_owned(),
                path,
                mime_type: Some(mime.to_owned()),
                size: metadata.len(),
                modified_at: modified_iso(&metadata),
            });
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        files
    }

    /// 附件引用抽取（对齐 Express extractAttachmentReferences）：
    /// 先剔除代码块/行内代码，再匹配 markdown 链接、wiki 链接、HTML src/href 与 wiki 嵌入，
    /// 逐条解析为 attachments/ 下的相对路径并按解析结果去重（保序）。
    fn extract_attachment_references(&self, content: &str, file_path: &str) -> Vec<String> {
        let source = strip_code_spans(content);
        let reference_pattern = regex::Regex::new(
            r#"(?i)!?(?:\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))[^)]*\)|\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]|(?:src|href)\s*=\s*["']([^"']+)["'])"#,
        );
        let embed_pattern = regex::Regex::new(r#"(?i)!\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]"#);
        let mut result = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut collect = |raw: &str| {
            if let Some(reference) = self.resolve_attachment_reference(raw, file_path)
                && seen.insert(reference.clone())
            {
                result.push(reference);
            }
        };
        if let Ok(pattern) = reference_pattern {
            for capture in pattern.captures_iter(&source) {
                let raw = (1..=4).find_map(|index| capture.get(index));
                if let Some(raw) = raw {
                    collect(raw.as_str());
                }
            }
        }
        if let Ok(pattern) = embed_pattern {
            for capture in pattern.captures_iter(&source) {
                if let Some(raw) = capture.get(1) {
                    collect(raw.as_str());
                }
            }
        }
        result
    }

    /// 单条引用 → attachments/ 相对路径（对齐 Express resolveAttachmentReference）：
    /// 拒绝外部协议/锚点，百分号解码，去掉 #/? 后缀，按「相对笔记目录优先或根目录优先」
    /// 的顺序尝试两个候选，存在的优先；都不存在时返回首个 attachments/ 候选。
    fn resolve_attachment_reference(&self, raw: &str, note_path: &str) -> Option<String> {
        let scheme = regex::Regex::new(r"(?i)^(?:[a-z][a-z\d+.-]*:|//|#)").ok()?;
        let reference = raw.trim();
        if reference.is_empty() || scheme.is_match(reference) {
            return None;
        }
        let decoded = percent_decode(reference)?;
        let reference = decoded
            .replace('\\', "/")
            .split('#')
            .next()
            .unwrap_or("")
            .split('?')
            .next()
            .unwrap_or("")
            .trim()
            .to_owned();
        if reference.is_empty() || posix_extname(&reference).is_empty() {
            return None;
        }
        let note_dir = if note_path.is_empty() { "" } else { posix_dirname(note_path) };
        let joined = if note_dir.is_empty() || note_dir == "." {
            reference.clone()
        } else {
            format!("{note_dir}/{reference}")
        };
        let root_reference = normalize_reference(&reference);
        let relative_reference = normalize_reference(&joined);
        let root_first =
            reference.starts_with("attachments/") || reference.starts_with('/');
        let candidates: Vec<Option<String>> = if root_first {
            vec![root_reference, relative_reference]
        } else {
            vec![relative_reference, root_reference]
        };
        for candidate in candidates.iter().flatten() {
            if !candidate.starts_with("attachments/") {
                continue;
            }
            if self.vault.root().join(candidate).exists() {
                return Some(candidate.clone());
            }
        }
        candidates
            .into_iter()
            .flatten()
            .find(|candidate| candidate.starts_with("attachments/"))
    }

    /// 清理 attachments/ 下的空父目录（对齐 Express removeEmptyParents，
    /// 从被删文件的父目录逐级向上，止于 attachments/ 根本身）。
    fn remove_empty_parents(&self, relative_dir: &str) {
        let stop = self.vault.root().join(Self::ATTACHMENT_ROOT);
        let mut current = self.vault.root().join(relative_dir);
        while current != stop && current.starts_with(&stop) {
            let is_empty = std::fs::read_dir(&current)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false);
            if !is_empty || std::fs::remove_dir(&current).is_err() {
                break;
            }
            let Some(parent) = current.parent().map(|path| path.to_path_buf()) else { break };
            current = parent;
        }
    }

    /// 全库扫描笔记正文，构建 附件路径 → 引用来源 的映射。
    /// 引用语法：markdown `![alt](attachments/…)`、链接 `(attachments/…)`、
    /// wiki 嵌入 `![[…]]`（对齐 ATTACHMENT_REFERENCE_RE / WIKI_EMBED_RE 的常见形态）。
    fn collect_reference_map(&self) -> Result<HashMap<String, Vec<ReferenceSource>>, String> {
        use crate::markdown::strip_frontmatter;
        let mut map: HashMap<String, Vec<ReferenceSource>> = HashMap::new();
        let index_entries = self.index.list_note_index()?;
        let pattern = regex::Regex::new(r#"(?:!\[[^\]]*\]|href="|src=")?\(([^)\s]+\.(?:png|jpe?g|gif|webp|svg|pdf|mp4|webm|mov|mp3|wav|m4a|ogg|zip|txt|md))\)|!\[\[([^\]]+)\]\]"#)
            .map_err(|error| error.to_string())?;
        for entry in index_entries {
            let content = match self.index.find_note_detail(Some(&entry.id), None) {
                Ok(Some(detail)) => detail.content,
                _ => continue,
            };
            let body = strip_frontmatter(&content);
            let mut seen = std::collections::HashSet::new();
            for capture in pattern.captures_iter(body) {
                let raw = capture
                    .get(1)
                    .or_else(|| capture.get(2))
                    .map(|m| m.as_str().trim().to_owned());
                let Some(raw) = raw else { continue };
                let decoded = raw.replace("%20", " ");
                let Some(position) = decoded.find(Self::ATTACHMENT_ROOT) else { continue };
                let relative = decoded[position..].to_owned();
                if seen.insert(relative.clone()) {
                    map.entry(relative).or_default().push(ReferenceSource {
                        file_path: entry.file_path.clone(),
                        title: entry.title.clone(),
                    });
                }
            }
        }
        Ok(map)
    }
}

/// 附件条目（对齐 Express listAttachments，camelCase 序列化）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub referenced_by: Vec<ReferenceSource>,
    pub orphan: bool,
}

/// 引用来源（引用附件的笔记）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceSource {
    pub file_path: String,
    pub title: String,
}

/// 附件引用详情（对齐 getAttachmentReferences）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReferences {
    pub path: String,
    pub referenced: bool,
    pub referenced_by: Vec<ReferenceSource>,
}

/// 全库文件条目（对齐 Express getVaultFileInfo；mimeType 不在白名单时为 null）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultFileEntry {
    pub path: String,
    pub name: String,
    pub mime_type: Option<String>,
    pub size: u64,
    pub modified_at: Option<String>,
}

/// 引用校验结果（对齐 Express validateReferences）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentValidation {
    pub references: Vec<String>,
    pub missing: Vec<String>,
}

/// 清理结果（对齐 Express cleanupOrphans）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCleanup {
    pub dry_run: bool,
    pub candidates: Vec<VaultFileEntry>,
    pub deleted: Vec<String>,
    pub skipped: Vec<CleanupSkipped>,
}

/// 清理跳过项：文件信息 + 原因（error 或 referencedBy，对齐 Express skipped 形状）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSkipped {
    #[serde(flatten)]
    pub file: VaultFileEntry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referenced_by: Option<Vec<ReferenceSource>>,
}

/// 下载负载（Express 为文件流；命令面以 base64 承载二进制）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultDownload {
    pub path: String,
    pub name: String,
    pub mime_type: Option<String>,
    pub size: u64,
    pub base64: String,
}

/// Express MIME_BY_EXTENSION 全量白名单（vault_files_list / validate / cleanup 共用口径）。
fn vault_file_mime(extension: &str) -> Option<&'static str> {
    match extension {
        "avif" => Some("image/avif"),
        "csv" => Some("text/csv"),
        "doc" => Some("application/msword"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "gif" => Some("image/gif"),
        "jpeg" | "jpg" => Some("image/jpeg"),
        "json" => Some("application/json"),
        "mp3" => Some("audio/mpeg"),
        "mp4" => Some("video/mp4"),
        "pdf" => Some("application/pdf"),
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "txt" => Some("text/plain"),
        "wav" => Some("audio/wav"),
        "webm" => Some("video/webm"),
        "webp" => Some("image/webp"),
        "xls" => Some("application/vnd.ms-excel"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        _ => None,
    }
}

/// 笔记类扩展名（不参与全库文件列表/下载），对齐 Express NOTE_FILE_EXTENSIONS。
fn is_note_extension(extension: &str) -> bool {
    matches!(extension, "md" | "markdown" | "canvas")
}

/// 可见性判定（对齐 Express isVisibleVaultPath）：无点开头段、无 node_modules、
/// 无 .tmp 结尾段，且不是笔记类文件。
fn is_visible_vault_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() {
        return false;
    }
    if normalized.split('/').any(|part| {
        part.starts_with('.') || part.eq_ignore_ascii_case("node_modules") || part.ends_with(".tmp")
    }) {
        return false;
    }
    !is_note_extension(
        posix_extname(&normalized)
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str(),
    )
}

/// 递归收集全库非笔记文件（对齐 Express walkVaultFiles）：跳过点开头条目、
/// .tmp 文件与 node_modules 目录；stat 瞬时失败的单项跳过而非整体失败。
fn walk_vault_files(root: &Path, directory: &Path, entries: &mut Vec<VaultFileEntry>) {
    let Ok(children) = std::fs::read_dir(directory) else { return };
    for child in children.flatten() {
        let name = child.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.ends_with(".tmp") || name.eq_ignore_ascii_case("node_modules") {
            continue;
        }
        let Ok(file_type) = child.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            walk_vault_files(root, &child.path(), entries);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let extension = posix_extname(&name).trim_start_matches('.').to_ascii_lowercase();
        if is_note_extension(&extension) {
            continue;
        }
        let absolute = child.path();
        let Ok(relative) = absolute.strip_prefix(root) else { continue };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let Ok(metadata) = child.metadata() else { continue };
        entries.push(VaultFileEntry {
            name,
            path: relative,
            mime_type: vault_file_mime(&extension).map(str::to_owned),
            size: metadata.len(),
            modified_at: modified_iso(&metadata),
        });
    }
}

/// stat.mtime → ISO-8601 UTC（对齐 Express stat.mtime.toISOString()）。
fn modified_iso(metadata: &std::fs::Metadata) -> Option<String> {
    let millis = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some(crate::time::iso8601_utc(millis))
}

/// posix.extname 等价物：取最后一段 basename 的最后一个 '.' 起子串；
/// 前导点（.gitignore）与无点（README）都返回空串。
fn posix_extname(path: &str) -> &str {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rfind('.') {
        Some(index) if index > 0 => &base[index..],
        _ => "",
    }
}

/// posix.dirname 等价物（仅用于引用解析的笔记目录拼接）。
fn posix_dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) => &path[..index],
        None => ".",
    }
}

/// 引用路径规范化（对齐 Express normalizeReference）：剥前导 '/'，
/// 折叠 '.'/重复斜杠，'..' 逃逸出根的一律拒绝。
fn normalize_reference(value: &str) -> Option<String> {
    let normalized = value.trim_start_matches('/').replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with("../") || normalized.contains("/../") {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// 严格百分号解码（对齐 decodeURIComponent）：非法 % 序列或非 UTF-8 返回 None；'+' 不变空格。
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let hi = (hex[0] as char).to_digit(16)?;
            let lo = (hex[1] as char).to_digit(16)?;
            output.push((hi * 16 + lo) as u8);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

/// 剔除代码区段（对齐 Express vault.attachments.js 的 stripCode）：
/// 围栏代码块（```/~~~）与行内代码整体移除，避免把示例当引用。
fn strip_code_spans(source: &str) -> String {
    let fenced = regex::Regex::new(r"```[\s\S]*?```|~~~[\s\S]*?~~~");
    let inline = regex::Regex::new(r"`[^`\n]*`");
    let source = match fenced {
        Ok(pattern) => pattern.replace_all(source, "").into_owned(),
        Err(_) => source.to_owned(),
    };
    match inline {
        Ok(pattern) => pattern.replace_all(&source, "").into_owned(),
        Err(_) => source,
    }
}

/// Windows 上附件常被预览窗格/杀软短暂占用：最多 3 次尝试、间隔 120ms；
/// ENOENT 视为已删除（对齐 Express unlinkWithRetry）。
fn remove_file_with_retry(path: &Path) -> Result<(), std::io::Error> {
    let mut attempt = 0;
    loop {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                attempt += 1;
                if attempt >= 3 {
                    return Err(if error.kind() == std::io::ErrorKind::PermissionDenied {
                        std::io::Error::new(
                            error.kind(),
                            "文件正被其他程序占用，无法删除，请稍后重试",
                        )
                    } else {
                        error
                    });
                }
                std::thread::sleep(std::time::Duration::from_millis(120));
            }
        }
    }
}

/// raw 全文哈希（与 Vault::write 的内容哈希同口径）。
fn meta_sha256(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

/// 历史版本条目（对齐 Express listSnapshots，camelCase 序列化）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub version: String,
    pub hash: String,
    pub created_at: Option<String>,
    pub size: u64,
}

/// 历史版本内容（对齐 Express readSnapshot）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    pub version: String,
    pub raw: String,
    pub hash: String,
}

/// 画布文档（对齐 Express canvas read，nodes/edges 为 Obsidian 兼容 JSON）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDocument {
    pub nodes: serde_json::Value,
    pub edges: serde_json::Value,
    pub revision: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{ServiceError, SNAPSHOT_LIMIT, WorkspaceService};

    fn open_service(directory: &Path) -> WorkspaceService {
        WorkspaceService::open(directory.to_path_buf()).unwrap()
    }

    use std::path::Path;

    const NOTE_ID: &str = "019501a2-3b4c-4c5d-89ab-cdef01234567";

    fn note_raw(content: &str) -> String {
        format!("---\nid: {NOTE_ID}\ntitle: 测试\n---\n\n{content}\n")
    }

    #[test]
    fn second_instance_is_rejected_with_vault_locked() {
        let directory = tempfile::tempdir().unwrap();
        let _first = open_service(directory.path());
        let second = WorkspaceService::open(directory.path().to_path_buf()).unwrap_err();
        assert_eq!(second.code, "VAULT_LOCKED");
        assert!(second.message.contains("已被另一个 Lattice 实例占用"));
    }

    #[test]
    fn lock_is_released_when_instance_drops() {
        let directory = tempfile::tempdir().unwrap();
        {
            let _first = open_service(directory.path());
        }
        let _second = open_service(directory.path()); // 不应报 VAULT_LOCKED
    }

    #[test]
    fn writes_are_audited_as_jsonl() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        service.write("a.md", "第一版", None, "test").unwrap();
        let audit = std::fs::read_to_string(directory.path().join(".lattice/audit.jsonl")).unwrap();
        let line = audit.lines().last().unwrap();
        let entry: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(entry["action"], "write");
        assert_eq!(entry["path"], "a.md");
        assert_eq!(entry["actor"], "test");
    }

    #[test]
    fn conflicts_are_audited_and_coded() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let first = service.write("a.md", "第一版", None, "test").unwrap();
        let error = service
            .write("a.md", "第二版", Some("outdated-hash"), "test")
            .unwrap_err();
        assert_eq!(error.code, "CONFLICT");
        let audit = std::fs::read_to_string(directory.path().join(".lattice/audit.jsonl")).unwrap();
        let entry: serde_json::Value = serde_json::from_str(audit.lines().last().unwrap()).unwrap();
        assert_eq!(entry["action"], "write_rejected");
        assert_eq!(entry["code"], "CONFLICT");
        let _ = first;
    }

    #[test]
    fn previous_content_is_snapshotted_before_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let first = service.write("a.md", &note_raw("v1"), None, "test").unwrap();
        service
            .write("a.md", &note_raw("v2"), Some(&first.sha256), "test")
            .unwrap();
        let history = directory.path().join(".lattice/history").join(NOTE_ID);
        let mut versions: Vec<String> = std::fs::read_dir(&history)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        versions.sort();
        assert_eq!(versions.len(), 1, "只应有一次覆盖产生一个快照：{versions:?}");
        let snapshotted =
            std::fs::read_to_string(history.join(&versions[0])).unwrap();
        assert!(snapshotted.contains("v1"), "快照应保存旧内容 v1");
        let version = versions[0].trim_end_matches(".md");
        let (stamp, _) = version.split_once('-').unwrap();
        assert_eq!(stamp.len(), 19, "版本名应为 8 位日期 + T + 9 位时间 + Z：{stamp}");
    }

    #[test]
    fn snapshot_skipped_when_latest_matches_previous_content() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let first = service.write("a.md", &note_raw("v1"), None, "test").unwrap();
        let second = service
            .write("a.md", &note_raw("v2"), Some(&first.sha256), "test")
            .unwrap();
        // 第三次保存相同内容：旧内容 v2 已是最新快照，不应新增
        service
            .write("a.md", &note_raw("v2"), Some(&second.sha256), "test")
            .unwrap();
        let history = directory.path().join(".lattice/history").join(NOTE_ID);
        let count = std::fs::read_dir(&history).unwrap().count();
        // v1 覆盖时快照 v1；v2 首次覆盖快照 v2；v2 重复保存跳过
        assert_eq!(count, 2, "内容与最新快照一致时不应新增快照");
    }

    #[test]
    fn notes_without_frontmatter_id_skip_snapshots_but_still_write() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let first = service.write("bare.md", "无 frontmatter", None, "test").unwrap();
        service
            .write("bare.md", "第二版", Some(&first.sha256), "test")
            .unwrap();
        let history = directory.path().join(".lattice/history");
        assert!(!history.exists(), "无 id 的笔记不应产生快照目录");
        let written = service.vault().read("bare.md").unwrap();
        assert_eq!(written.raw, "第二版");
    }

    #[test]
    fn snapshot_pruning_keeps_only_the_newest() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let limit = 3;
        let mut expected_hash = None;
        for round in 0..=limit {
            let raw = note_raw(&format!("v{round}"));
            // 直接经快照器写入历史：绕过 SNAPSHOT_LIMIT 常量以验证剪枝参数
            if round > 0 {
                let previous = service.vault().read("a.md").unwrap();
                let store = super::SnapshotStore::open(&directory.path().join(".lattice"));
                store.create(super::frontmatter_id(&previous.raw).unwrap().as_str(), &previous.raw, limit).unwrap();
                expected_hash = Some(previous.sha256.clone());
            }
            service.write("a.md", &raw, expected_hash.as_deref(), "test").unwrap();
        }
        let history = directory.path().join(".lattice/history").join(NOTE_ID);
        let count = std::fs::read_dir(&history).unwrap().count();
        assert!(count <= limit, "快照数 {count} 应被剪枝到 ≤ {limit}");
        let _ = SNAPSHOT_LIMIT;
    }

    #[test]
    fn service_error_serializes_with_code_and_message() {
        let error = ServiceError::new("CONFLICT", "内容已变化");
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["code"], "CONFLICT");
        assert_eq!(json["message"], "内容已变化");
    }

    fn write_file(root: &Path, relative: &str, bytes: &[u8]) {
        let target = root.join(relative);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, bytes).unwrap();
    }

    #[test]
    fn vault_files_list_excludes_notes_hidden_tmp_and_node_modules() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        write_file(directory.path(), "note.md", b"md");
        write_file(directory.path(), "board.canvas", b"{}");
        write_file(directory.path(), "docs/paper.pdf", b"pdf");
        write_file(directory.path(), "node_modules/pkg/index.js", b"js");
        write_file(directory.path(), ".hidden/secret.txt", b"txt");
        write_file(directory.path(), "scratch.tmp", b"tmp");
        write_file(directory.path(), "attachments/pic.png", b"png");
        write_file(directory.path(), "data.bin", b"bin");
        let paths: Vec<String> = service
            .vault_files_list()
            .unwrap()
            .into_iter()
            .map(|entry| entry.path)
            .collect();
        assert_eq!(paths, vec!["attachments/pic.png", "data.bin", "docs/paper.pdf"]);
        let entries = service.vault_files_list().unwrap();
        assert_eq!(entries[0].mime_type.as_deref(), Some("image/png"));
        assert_eq!(entries[1].mime_type, None, "未知扩展名 mimeType 应为 null");
        assert!(entries[2].modified_at.is_some(), "modifiedAt 应为 ISO 时间");
    }

    #[test]
    fn attachment_validate_reports_references_and_missing() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        write_file(directory.path(), "attachments/exists.png", b"png");
        let content = "[link](attachments/exists.png)\n\
            ![img](attachments/missing.png)\n\
            [ext](https://example.com/x.png)\n\
            ![[attachments/exists.png]]\n\
            `(attachments/fake.png)`\n";
        let outcome = service.attachment_validate(content, "").unwrap();
        assert_eq!(
            outcome.references,
            vec!["attachments/exists.png", "attachments/missing.png"],
            "外部协议与行内代码不应计入，重复引用应去重"
        );
        assert_eq!(outcome.missing, vec!["attachments/missing.png"]);
    }

    #[test]
    fn attachment_cleanup_respects_confirmation_and_keeps_referenced() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        write_file(directory.path(), "attachments/orphan.png", b"orphan");
        write_file(directory.path(), "attachments/used.png", b"used");
        write_file(directory.path(), "attachments/note.txt", b"txt");
        service
            .write("a.md", &note_raw("![used](attachments/used.png)"), None, "test")
            .unwrap();

        let preview = service.attachment_cleanup(true, false, false).unwrap();
        assert!(preview.dry_run);
        let candidates: Vec<&str> = preview.candidates.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(candidates, vec!["attachments/note.txt", "attachments/orphan.png"]);

        let rejected = service.attachment_cleanup(false, true, false).unwrap_err();
        assert_eq!(rejected.code, "CONFIRMATION_REQUIRED");

        let outcome = service.attachment_cleanup(false, true, true).unwrap();
        assert!(!outcome.dry_run);
        assert_eq!(outcome.deleted, vec!["attachments/note.txt", "attachments/orphan.png"]);
        assert!(outcome.skipped.is_empty());
        assert!(!directory.path().join("attachments/orphan.png").exists());
        assert!(!directory.path().join("attachments/note.txt").exists());
        assert!(directory.path().join("attachments/used.png").exists(), "被引用附件必须保留");
    }

    #[test]
    fn vault_download_reads_visible_files_and_rejects_others() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        write_file(directory.path(), "docs/report.pdf", b"%PDF-fake");
        let download = service.vault_download("docs/report.pdf").unwrap();
        assert_eq!(download.name, "report.pdf");
        assert_eq!(download.mime_type.as_deref(), Some("application/pdf"));
        assert_eq!(download.size, 9);
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&download.base64)
            .unwrap();
        assert_eq!(bytes, b"%PDF-fake");

        let note = service.vault_download("note.md").unwrap_err();
        assert_eq!(note.code, "VALIDATION");
        let traversal = service.vault_download("../outside.png").unwrap_err();
        assert_eq!(traversal.code, "VALIDATION");
        let missing = service.vault_download("attachments/missing.png").unwrap_err();
        assert_eq!(missing.code, "NOT_FOUND");
    }
}
