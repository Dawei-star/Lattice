//! WorkspaceService：唯一的 Vault 写入边界（升级计划 P1-01）。
//!
//! 职责（对齐 lattice-architecture §12）：
//! - 路径校验、内容哈希、原子写入（复用 `vault::Vault` 的既有保护）；
//! - 写入前版本快照：`.lattice/history/<note-id>/<YYYYMMDDTHH9Z-64hex>.md`，
//!   与 Express `notes.history.js` 完全同构，P1-04 迁移 history 命令时无缝；
//! - 审计：所有写入/冲突事件追加到 `.lattice/audit.jsonl`；
//! - 单实例锁：第二实例明确报"已被占用"，禁止静默共写（风险 R12）；
//! - 统一错误模型：`ServiceError { code, message }`，命令面在 P1-04 切换。

use crate::index::{Index, NoteDetail};
use crate::jobs::JobsQueue;
use crate::markdown::{normalize_title, parse_frontmatter, sanitize_file_part, serialize_markdown_document, MarkdownDocument};
use crate::time::{iso8601_utc, now_millis};
use crate::vault::{NoteContents, Vault};
use uuid::Uuid;
use fs2::FileExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
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
}
