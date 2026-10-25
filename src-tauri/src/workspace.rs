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
use crate::markdown::{
    MarkdownDocument, normalize_title, parse_frontmatter, sanitize_file_part,
    serialize_markdown_document, strip_frontmatter,
};
use crate::ai::core::context::memory::{MemoryError, MemoryRecord, MemoryStore};
use crate::time::{iso8601_utc, now_millis};
use crate::vault::{NoteContents, Vault, VaultInfo};
use fs2::FileExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use uuid::Uuid;

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
        Self {
            code,
            message: message.into(),
        }
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
        Ok(Self {
            path: lattice_dir.join("audit.jsonl"),
        })
    }

    fn record(&self, action: &str, fields: &[(&str, &str)]) {
        let mut entry = serde_json::Map::new();
        entry.insert(
            "ts".into(),
            serde_json::json!(crate::time::iso8601_utc(crate::time::now_millis())),
        );
        entry.insert("action".into(), serde_json::json!(action));
        for (key, value) in fields {
            entry.insert((*key).into(), serde_json::json!(value));
        }
        if let Ok(line) = serde_json::to_string(&entry)
            && let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
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
        Self {
            root: lattice_dir.join("history"),
        }
    }

    /// 列出某笔记的全部快照，按版本名倒序（时间戳前缀保证字典序即时间序）。
    fn list(&self, note_id: &str) -> Vec<SnapshotMeta> {
        let mut snapshots = Vec::new();
        let Ok(entries) = fs::read_dir(self.root.join(note_id)) else {
            return snapshots;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(stripped) = name.strip_suffix(".md") else {
                continue;
            };
            let Some((stamp, hash)) = stripped.split_once('-') else {
                continue;
            };
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
        for stale in self
            .list(note_id)
            .iter()
            .take(existing.len().saturating_sub(limit - 1))
        {
            let _ = fs::remove_file(
                self.root
                    .join(note_id)
                    .join(format!("{}.md", stale.version)),
            );
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
        || !stamp
            .chars()
            .filter(|c| *c != 'T' && *c != 'Z')
            .all(|c| c.is_ascii_digit())
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
    memories: MemoryStore,
    ai_settings: crate::ai::core::config::AiSettingsStore,
    prompts: crate::ai::core::prompt::PromptRegistry,
    trace_store: crate::ai::core::trace::TraceStore,
    _lock: File, // 句柄存活期间锁有效；drop 即释放
}

const MCP_CONFIG_DIRECTORY: &str = ".lattice";
const MCP_CONFIG_FILE: &str = "mcp.json";
const MCP_MAX_SERVERS: usize = 16;
const MCP_MAX_KEY_LENGTH: usize = 80;
const MCP_MAX_FIELD_LENGTH: usize = 4096;
const MCP_MAX_ENV_ENTRIES: usize = 64;

/// 项目级 MCP 配置状态。配置文件只描述外部连接，不代表 sidecar 已经启动。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProjectState {
    pub path: String,
    pub status: String,
    pub warning: Option<String>,
    pub servers: Vec<McpServerEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpServerEntry {
    pub key: String,
    pub name: String,
    pub description: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: String,
    pub enabled: bool,
}

fn mcp_string(value: Option<&serde_json::Value>, max: usize) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(max)
        .collect()
}

fn mcp_trimmed_string(value: Option<&serde_json::Value>, max: usize) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(max)
        .collect()
}

fn mcp_source(value: &serde_json::Value) -> Option<&serde_json::Map<String, serde_json::Value>> {
    let object = value.as_object()?;
    object
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
        .or(Some(object))
}

fn mcp_normalize_entry(key: &str, raw: &serde_json::Value) -> Option<McpServerEntry> {
    let object = raw.as_object()?;
    let key: String = key.trim().chars().take(MCP_MAX_KEY_LENGTH).collect();
    if key.is_empty() {
        return None;
    }
    let url = mcp_trimmed_string(object.get("url"), MCP_MAX_FIELD_LENGTH);
    let transport = if object.get("transport").and_then(serde_json::Value::as_str) == Some("sse")
        || !url.is_empty()
    {
        "sse"
    } else {
        "stdio"
    };
    let name = {
        let value = mcp_trimmed_string(object.get("name"), 120);
        if value.is_empty() { key.clone() } else { value }
    };
    let command = mcp_trimmed_string(object.get("command"), MCP_MAX_FIELD_LENGTH);
    let args = object
        .get("args")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|item| item.chars().take(MCP_MAX_FIELD_LENGTH).collect())
                .take(64)
                .collect()
        })
        .unwrap_or_default();
    let env = object
        .get("env")
        .and_then(serde_json::Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(name, value)| {
                    if name.is_empty() || !value.is_string() {
                        return None;
                    }
                    let name = name.chars().take(200).collect::<String>();
                    Some((
                        name,
                        value
                            .as_str()
                            .unwrap_or_default()
                            .chars()
                            .take(MCP_MAX_FIELD_LENGTH)
                            .collect::<String>(),
                    ))
                })
                .take(MCP_MAX_ENV_ENTRIES)
                .collect()
        })
        .unwrap_or_default();
    let valid_http_url = url
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
        || url
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"));
    if (transport == "stdio" && command.is_empty()) || (transport == "sse" && !valid_http_url) {
        return None;
    }
    Some(McpServerEntry {
        key,
        name,
        description: mcp_string(object.get("description"), 300),
        transport: transport.to_owned(),
        command,
        args,
        env,
        url,
        enabled: object.get("enabled").and_then(serde_json::Value::as_bool) != Some(false),
    })
}

fn mcp_normalize_document(value: &serde_json::Value) -> (Vec<McpServerEntry>, usize) {
    let Some(source) = mcp_source(value) else {
        return (Vec::new(), 0);
    };
    let source_count = source.len();
    let mut servers = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (key, raw) in source {
        let Some(server) = mcp_normalize_entry(key, raw) else {
            continue;
        };
        if !seen.insert(server.key.clone()) {
            continue;
        }
        servers.push(server);
        if servers.len() >= MCP_MAX_SERVERS {
            break;
        }
    }
    (servers, source_count)
}

fn mcp_server_document(server: &McpServerEntry) -> serde_json::Value {
    let mut value = serde_json::Map::new();
    value.insert("name".into(), serde_json::json!(server.name));
    value.insert("description".into(), serde_json::json!(server.description));
    value.insert("transport".into(), serde_json::json!(server.transport));
    if server.transport == "sse" {
        value.insert("url".into(), serde_json::json!(server.url));
    } else {
        value.insert("command".into(), serde_json::json!(server.command));
        value.insert("args".into(), serde_json::json!(server.args));
    }
    value.insert("env".into(), serde_json::json!(server.env));
    value.insert("enabled".into(), serde_json::json!(server.enabled));
    serde_json::Value::Object(value)
}

fn is_template_name(name: &str) -> bool {
    name.len() > 3
        && name.to_ascii_lowercase().ends_with(".md")
        && !name.contains(['/', '\\', ':'])
        && !name.contains("..")
}

fn template_name(value: &str) -> Result<String, ServiceError> {
    let name = value.trim().trim_end_matches(".md").to_owned();
    if name.is_empty() || !is_template_name(&format!("{name}.md")) {
        return Err(ServiceError::new("VALIDATION", "Invalid template name"));
    }
    Ok(name)
}

fn normalize_date(value: Option<&str>) -> Result<String, ServiceError> {
    let date = match value {
        Some(value) if !value.is_empty() => value.to_owned(),
        _ => {
            let millis = crate::time::now_millis();
            let seconds = millis.div_euclid(1000);
            let days = seconds.div_euclid(86_400);
            // Civil date conversion from Unix days, valid for the supported Vault date range.
            let z = days + 719_468;
            let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
            let doe = z - era * 146_097;
            let yoe = (doe - doe.div_euclid(1_460) + doe.div_euclid(36_524)
                - doe.div_euclid(146_096))
            .div_euclid(365);
            let year = yoe + era * 400;
            let doy = doe - (365 * yoe + yoe.div_euclid(4) - yoe.div_euclid(100));
            let mp = (5 * doy + 2).div_euclid(153);
            let day = doy - (153 * mp + 2).div_euclid(5) + 1;
            let month = mp + if mp < 10 { 3 } else { -9 };
            let year = year + if month <= 2 { 1 } else { 0 };
            format!("{year:04}-{month:02}-{day:02}")
        }
    };
    let valid = date.len() == 10
        && date.as_bytes()[4] == b'-'
        && date.as_bytes()[7] == b'-'
        && date
            .chars()
            .enumerate()
            .all(|(index, ch)| index == 4 || index == 7 || ch.is_ascii_digit());
    if !valid {
        return Err(ServiceError::new(
            "VALIDATION",
            "Date must use YYYY-MM-DD format",
        ));
    }
    let year = date[0..4].parse::<u32>().unwrap_or(0);
    let month = date[5..7].parse::<u32>().unwrap_or(0);
    let day = date[8..10].parse::<u32>().unwrap_or(0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100)) => {
            29
        }
        2 => 28,
        _ => 0,
    };
    if year == 0 || month == 0 || day == 0 || day > days_in_month {
        return Err(ServiceError::new(
            "VALIDATION",
            "Date must be a valid calendar date",
        ));
    }
    Ok(date)
}

fn builtin_templates() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "bug",
            "---\ntype: bug\nstatus: open\npriority: medium\nproject:\n---\n# {{title}}\n\n## 现象\n\n\n## 复现步骤\n\n1.\n\n## 预期结果\n\n\n## 实际结果\n\n\n## 根因与修复\n",
        ),
        (
            "decision",
            "---\ntype: decision\nstatus: proposed\nproject:\n---\n# {{title}}\n\n## 背景\n\n\n## 方案\n\n\n## 决策\n\n\n## 影响\n",
        ),
        (
            "meeting",
            "---\ntype: meeting\nstatus: open\nproject:\n---\n# {{title}}\n\n日期：{{date}}\n时间：{{time}}\n\n## 参与者\n\n\n## 讨论\n\n\n## 结论与行动项\n\n- [ ]\n",
        ),
        (
            "learning",
            "---\ntype: learning\nstatus: draft\nproject:\n---\n# {{title}}\n\n## 问题\n\n\n## 结论\n\n\n## 示例\n\n```\n```\n\n## 相关链接\n",
        ),
        (
            "retrospective",
            "---\ntype: retrospective\nstatus: draft\nproject:\n---\n# {{title}}\n\n## 做得好的地方\n\n\n## 遇到的问题\n\n\n## 下一步改进\n\n- [ ]\n",
        ),
        (
            "daily",
            "---\ntype: daily\nstatus: draft\n---\n# {{title}}\n\n",
        ),
    ]
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
        let vault = Vault::open(root)
            .map_err(|error| ServiceError::new("VAULT_OPEN_FAILED", error.to_string()))?;
        let index = Index::open(vault.root())
            .map_err(|error| ServiceError::new("INDEX_OPEN_FAILED", error))?;
        let audit = AuditLog::open(&lattice_dir)?;
        let jobs = JobsQueue::open(lattice_dir.join("lattice.db").as_path())
            .map_err(|error| ServiceError::new("JOBS_OPEN_FAILED", error))?;
        let memories = MemoryStore::open(lattice_dir.join("lattice.db").as_path())
            .map_err(|error| ServiceError::new("MEMORY_OPEN_FAILED", error))?;
        let ai_settings =
            crate::ai::core::config::AiSettingsStore::open(lattice_dir.join("lattice.db").as_path())
                .map_err(|error| ServiceError::new("AI_SETTINGS_OPEN_FAILED", error))?;
        // Prompt 注册表：内置模板启动 fail-fast；用户覆盖文件损坏只跳过不拖垮启动
        let prompts = crate::ai::core::prompt::PromptRegistry::builtin()
            .map_err(|error| ServiceError::new("PROMPT_REGISTRY_INVALID", error))?
            .merged_with_override(&lattice_dir.join("prompts"));
        let trace_store =
            crate::ai::core::trace::TraceStore::open(lattice_dir.join("lattice.db").as_path())
                .map_err(|error| ServiceError::new("TRACE_OPEN_FAILED", error))?;
        let recovered = jobs.recover_interrupted().unwrap_or(0);
        if recovered > 0 {
            log::info!("启动恢复：{recovered} 个中断任务已重排回队列");
        }
        audit.record(
            "workspace_open",
            &[("path", &vault.root().to_string_lossy())],
        );
        Ok(Self {
            vault,
            index,
            audit,
            snapshots: SnapshotStore::open(&lattice_dir),
            jobs,
            memories,
            ai_settings,
            prompts,
            trace_store,
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
        let note = self
            .vault
            .write(path, raw, expected_hash)
            .map_err(|error| {
                let code = if error.contains("changed on disk") || error.contains("removed before")
                {
                    "CONFLICT"
                } else {
                    "WRITE_FAILED"
                };
                self.audit.record(
                    "write_rejected",
                    &[("path", path), ("code", code), ("actor", actor)],
                );
                ServiceError::new(code, error)
            })?;
        // 旧内容与最新快照一致时 create 内部会跳过；无 frontmatter id 的文件跳过快照
        if let Some(previous) = previous {
            match frontmatter_id(&previous.raw) {
                Some(note_id) => {
                    match self
                        .snapshots
                        .create(&note_id, &previous.raw, SNAPSHOT_LIMIT)
                    {
                        Ok(Some(version)) => {
                            self.audit.record(
                                "snapshot",
                                &[("path", path), ("version", &version), ("actor", actor)],
                            );
                        }
                        Ok(None) => {}
                        Err(error) => log::warn!("快照失败（不阻断写入）：{error}"),
                    }
                }
                None => log::debug!("跳过快照：{path} 缺少合法的 frontmatter id"),
            }
        }
        self.audit.record(
            "write",
            &[("path", path), ("hash", &note.sha256), ("actor", actor)],
        );
        // 索引是可重建投影：同步失败只告警，下次扫描自愈
        if let Ok(meta) = self.vault.stat(&note.path)
            && let Err(error) = self.index.upsert(
                &note.path,
                &note.raw,
                &note.sha256,
                meta.bytes,
                meta.modified_at,
            )
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

    pub fn vault_info(&self) -> VaultInfo {
        self.vault.info()
    }

    fn mcp_config_path(&self) -> Result<PathBuf, ServiceError> {
        let path = self
            .vault
            .root()
            .join(MCP_CONFIG_DIRECTORY)
            .join(MCP_CONFIG_FILE);
        fc_assert_no_symlink(self.vault.root(), &path)
            .map_err(|error| ServiceError::new("VALIDATION", error))?;
        Ok(path)
    }

    /// 读取项目级 MCP 配置；只读取 `.lattice/mcp.json`，不连接或启动任何 Server。
    pub fn mcp_project_get(&self) -> Result<McpProjectState, ServiceError> {
        let path = self.mcp_config_path()?;
        let path_text = path.to_string_lossy().into_owned();
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(McpProjectState {
                    path: path_text,
                    status: "default".into(),
                    warning: None,
                    servers: Vec::new(),
                });
            }
            Err(error) => {
                return Ok(McpProjectState {
                    path: path_text,
                    status: "invalid".into(),
                    warning: Some(format!("无法读取配置：{error}")),
                    servers: Vec::new(),
                });
            }
        };
        let document = match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(document) => document,
            Err(error) => {
                return Ok(McpProjectState {
                    path: path_text,
                    status: "invalid".into(),
                    warning: Some(format!("JSON 解析失败：{error}")),
                    servers: Vec::new(),
                });
            }
        };
        let (servers, _) = mcp_normalize_document(&document);
        Ok(McpProjectState {
            path: path_text,
            status: "loaded".into(),
            warning: None,
            servers,
        })
    }

    /// 归一化并原子保存项目级 MCP 配置；confirmed 是文件写入闸门。
    pub fn mcp_project_set(
        &self,
        document: serde_json::Value,
        confirmed: bool,
    ) -> Result<McpProjectState, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "保存项目级 MCP 配置需要 confirmed=true",
            ));
        }
        if !document.is_object() || document.is_array() {
            return Err(ServiceError::new(
                "VALIDATION",
                "项目级 MCP 配置必须是 JSON 对象",
            ));
        }
        let path = self.mcp_config_path()?;
        let (servers, source_count) = mcp_normalize_document(&document);
        let mut normalized = serde_json::Map::new();
        for server in &servers {
            normalized.insert(server.key.clone(), mcp_server_document(server));
        }
        let persisted = serde_json::json!({ "mcpServers": normalized });
        let raw = format!(
            "{}\n",
            serde_json::to_string_pretty(&persisted)
                .map_err(|error| ServiceError::new("VALIDATION", error.to_string()))?
        );
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
        }
        fc_write_atomic(&path, &raw).map_err(|error| ServiceError::new("IO_ERROR", error))?;
        let dropped = source_count.saturating_sub(servers.len());
        let count = servers.len().to_string();
        self.audit.record(
            "mcp_project_write",
            &[
                ("path", ".lattice/mcp.json"),
                ("servers", &count),
                ("actor", "ui"),
            ],
        );
        let mut result = self.mcp_project_get()?;
        result.warning = (dropped > 0)
            .then(|| format!("{dropped} 个无效条目已被忽略（缺 command / URL 非法等）。"));
        Ok(result)
    }

    pub fn save_vault_profile(
        &self,
        profile: serde_json::Value,
        confirmed: bool,
    ) -> Result<VaultInfo, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "修改 Vault profile 需要 confirmed=true",
            ));
        }
        self.vault
            .save_profile(profile)
            .map_err(|error| ServiceError::new("VALIDATION", error))
    }

    pub fn duplicate_note(
        &self,
        id: &str,
        folder_id: Option<String>,
        confirmed: bool,
    ) -> Result<NoteDetail, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "创建笔记副本需要 confirmed=true",
            ));
        }
        let current = self
            .index
            .find_note_detail(Some(id), None)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "笔记不存在"))?;
        let properties = current.properties.as_object().cloned().unwrap_or_default();
        let target_folder = folder_id.or(current.folder_id.clone());
        self.create_note(
            None,
            Some(format!("{}（副本）", current.title)),
            strip_frontmatter(&current.content),
            target_folder,
            &properties,
            true,
        )
    }

    pub fn list_templates(&self) -> Result<Vec<serde_json::Value>, ServiceError> {
        let directory = self.vault.root().join("_templates");
        let has_user_templates = fs::read_dir(&directory)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .any(|entry| {
                entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
                    && is_template_name(&entry.file_name().to_string_lossy())
            });
        let mut templates = Vec::new();
        if has_user_templates {
            for entry in fs::read_dir(&directory)
                .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?
                .flatten()
            {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
                    || !is_template_name(&name)
                {
                    continue;
                }
                let raw = fs::read_to_string(entry.path())
                    .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
                let meta = parse_frontmatter(&raw).unwrap_or_default();
                let modified_at = entry
                    .metadata()
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|value| iso8601_utc(value.as_millis() as i64))
                    .unwrap_or_default();
                templates.push(serde_json::json!({ "name": name.trim_end_matches(".md"), "filePath": format!("_templates/{name}"), "title": meta.title.unwrap_or_else(|| name.trim_end_matches(".md").to_owned()), "size": raw.len(), "updatedAt": modified_at }));
            }
        } else {
            for (name, raw) in builtin_templates() {
                let meta = parse_frontmatter(raw).unwrap_or_default();
                templates.push(serde_json::json!({ "name": name, "filePath": format!("_templates/{name}.md"), "title": meta.title.unwrap_or_else(|| name.to_owned()), "size": raw.len(), "updatedAt": "" }));
            }
        }
        templates.sort_by(|left, right| {
            left["name"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["name"].as_str().unwrap_or_default())
        });
        Ok(templates)
    }

    pub fn create_from_template(
        &self,
        template: &str,
        title: Option<String>,
        date: Option<String>,
        folder_id: Option<String>,
        confirmed: bool,
    ) -> Result<NoteDetail, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "从模板创建笔记需要 confirmed=true",
            ));
        }
        let name = template_name(template)?;
        let user_path = self
            .vault
            .root()
            .join("_templates")
            .join(format!("{name}.md"));
        let raw = if user_path.is_file() {
            fs::read_to_string(user_path)?
        } else {
            builtin_templates()
                .into_iter()
                .find(|(key, _)| *key == name)
                .map(|(_, raw)| raw.to_owned())
                .ok_or_else(|| ServiceError::new("NOT_FOUND", "Template not found"))?
        };
        let resolved_date = normalize_date(date.as_deref())?;
        let resolved_title = title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| parse_frontmatter(&raw).and_then(|meta| meta.title))
            .unwrap_or_else(|| name.clone());
        let rendered = raw
            .replace("{{title}}", &resolved_title)
            .replace("{{date}}", &resolved_date)
            .replace("{{time}}", "00:00");
        let meta = parse_frontmatter(&rendered).unwrap_or_default();
        let content = strip_frontmatter(&rendered).to_owned();
        self.create_note(
            None,
            Some(resolved_title),
            &content,
            folder_id,
            &meta.properties,
            true,
        )
    }

    pub fn create_daily_note(
        &self,
        date: Option<String>,
        confirmed: bool,
    ) -> Result<NoteDetail, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "创建每日笔记需要 confirmed=true",
            ));
        }
        let date = normalize_date(date.as_deref())?;
        let profile = self.vault.info().profile;
        let daily = profile["paths"]["daily"]
            .as_str()
            .unwrap_or("Daily")
            .to_owned();
        self.vault
            .ensure_directory(&daily)
            .map_err(|error| ServiceError::new("IO_ERROR", error))?;
        let folder_id = crate::index::stable_folder_id(&daily);
        let path = format!("{daily}/{date}.md");
        if let Some(note) = self
            .index
            .find_note_detail(None, Some(&path))
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
        {
            return Ok(note);
        }
        if self.vault.root().join(&path).is_file() {
            self.index
                .scan(&self.vault)
                .map_err(|error| ServiceError::new("SCAN_ERROR", error))?;
            if let Some(note) = self
                .index
                .find_note_detail(None, Some(&path))
                .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            {
                return Ok(note);
            }
            return Err(ServiceError::new(
                "CONFLICT",
                "每日笔记文件已存在但无法建立投影",
            ));
        }
        self.create_from_template(
            "daily",
            Some(date.clone()),
            Some(date),
            Some(folder_id),
            true,
        )
    }

    /// 生成或更新当天的本地摘要笔记。
    ///
    /// 摘要是确定性的本地汇总，不调用云模型，也不创建独立的 AI 正文存储。
    /// 用户点击每日摘要按钮即构成确认，最终文件仍经 create_note/update_note
    /// 进入 WorkspaceService 的快照、冲突、索引和审计边界。
    pub fn generate_ai_digest(
        &self,
        date: Option<String>,
        confirmed: bool,
    ) -> Result<serde_json::Value, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "生成每日摘要需要 confirmed=true",
            ));
        }
        let date = normalize_date(date.as_deref())?;
        let profile = self.vault.info().profile;
        let journal = profile["paths"]["journal"]
            .as_str()
            .unwrap_or("Journal")
            .to_owned();
        self.vault
            .ensure_directory(&journal)
            .map_err(|error| ServiceError::new("IO_ERROR", error))?;

        let source_notes = self
            .index
            .digest_notes(&date, &journal)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
        let title = format!("每日摘要 {date}");
        let file_path = format!("{journal}/{title}.md");
        let mut sections = vec![
            format!("今天共修改 {} 篇笔记。", source_notes.len()),
            String::new(),
            "## 修改的笔记".to_owned(),
            String::new(),
        ];
        if source_notes.is_empty() {
            sections.push("- （无）".to_owned());
        } else {
            for note in &source_notes {
                let safe_title = note.title.replace(['[', ']'], "");
                let time = note
                    .updated_at
                    .as_deref()
                    .and_then(|value| value.get(11..16))
                    .unwrap_or("--:--");
                sections.push(format!(
                    "- [[{}]]（{} 字，{} 更新）",
                    safe_title, note.word_count, time
                ));
                if !note.excerpt.is_empty() {
                    sections.push(format!("  > {}", note.excerpt));
                }
            }
        }
        sections.extend([
            String::new(),
            "---".to_owned(),
            format!(
                "由 Lattice 自动生成于 {}（本地模式）。",
                iso8601_utc(now_millis())
            ),
        ]);
        let content = sections.join("\n");

        let mut existing = self
            .index
            .find_note_detail(None, Some(&file_path))
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
        if existing.is_none() && self.vault.root().join(&file_path).is_file() {
            self.index
                .scan(&self.vault)
                .map_err(|error| ServiceError::new("SCAN_ERROR", error))?;
            existing = self
                .index
                .find_note_detail(None, Some(&file_path))
                .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
        }

        if let Some(note) = existing {
            let updated = self.update_note(
                &note.id,
                None,
                Some(content),
                None,
                None,
                None,
                note.content_hash.clone(),
                true,
            )?;
            return Ok(serde_json::json!({
                "noteId": updated.id,
                "title": updated.title,
                "filePath": updated.file_path,
                "created": false,
                "modifiedCount": source_notes.len(),
                "aiOverview": false,
            }));
        }

        let folder_id = crate::index::stable_folder_id(&journal);
        let mut properties = serde_json::Map::new();
        properties.insert("type".to_owned(), serde_json::json!("digest"));
        let created = self.create_note(
            None,
            Some(title),
            &content,
            Some(folder_id),
            &properties,
            true,
        )?;
        Ok(serde_json::json!({
            "noteId": created.id,
            "title": created.title,
            "filePath": created.file_path,
            "created": true,
            "modifiedCount": source_notes.len(),
            "aiOverview": false,
        }))
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

    pub fn memory_list(&self, include_expired: bool) -> Result<Vec<MemoryRecord>, ServiceError> {
        self.memories
            .list(include_expired)
            .map_err(|error| ServiceError::new("MEMORY_ERROR", error))
    }

    /// 读取脱敏设置文档，并为每个 provider 附 `keyAvailable`
    /// （密钥能否从环境变量解析；真实密钥永不进入返回值）。
    pub fn ai_settings_load(&self) -> Result<serde_json::Value, ServiceError> {
        let mut document = self
            .ai_settings
            .load()
            .map_err(|error| ServiceError::new("AI_SETTINGS_ERROR", error))?;
        if let Some(providers) = document
            .get_mut("providers")
            .and_then(serde_json::Value::as_array_mut)
        {
            for provider in providers {
                let available = provider
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .and_then(crate::ai::core::config::env_secret)
                    .is_some();
                if let Some(object) = provider.as_object_mut() {
                    object.insert(
                        "keyAvailable".to_owned(),
                        serde_json::Value::Bool(available),
                    );
                }
            }
        }
        Ok(document)
    }

    /// 保存设置：Rust 边界白名单脱敏（真实 Key 只留掩码）后落盘，返回脱敏文档。
    pub fn ai_settings_save(
        &self,
        document: &serde_json::Value,
    ) -> Result<serde_json::Value, ServiceError> {
        let sanitized = self
            .ai_settings
            .save(document)
            .map_err(|error| ServiceError::new("AI_SETTINGS_ERROR", error))?;
        let provider_count = sanitized
            .get("providers")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        let provider_label = provider_count.to_string();
        self.audit
            .record("ai_settings_set", &[("providers", &provider_label)]);
        Ok(sanitized)
    }

    /// 模型目录（W3）：内置 models.json + `<Vault>/.lattice/models.json` 覆盖，
    /// 含能力 / 价格 / 开放权重标记。目录是数据不是代码（地基 §5.1）。
    pub fn ai_models_catalog(&self) -> serde_json::Value {
        let catalog = crate::ai::core::provider::catalog::ModelCatalog::builtin()
            .merged_with_override(&self.vault.root().join(".lattice").join("models.json"));
        serde_json::to_value(catalog).unwrap_or_else(|_| serde_json::json!({}))
    }

    /// Prompt 模板状态（W5）：id / 版本 / 是否被 `.lattice/prompts` 覆盖。
    pub fn ai_prompts_list(&self) -> Vec<crate::ai::core::prompt::PromptStatus> {
        self.prompts.list()
    }

    /// 指标落库（W8）：run 维度计量条目，凭据与正文永不入库。
    pub fn ai_trace_record(
        &self,
        entry: &crate::ai::core::trace::TraceEntry,
    ) -> Result<(), ServiceError> {
        self.trace_store
            .record(entry)
            .map_err(|error| ServiceError::new("TRACE_ERROR", error))
    }

    /// 指标查询（W8）：最近明细 + 按 task_type 的 P50/P95 汇总。
    pub fn ai_trace_query(
        &self,
        task_type: Option<&str>,
        limit: u32,
    ) -> Result<serde_json::Value, ServiceError> {
        let result = self
            .trace_store
            .query(task_type, limit)
            .map_err(|error| ServiceError::new("TRACE_ERROR", error))?;
        serde_json::to_value(result)
            .map_err(|error| ServiceError::new("TRACE_ERROR", format!("指标序列化失败：{error}")))
    }

    pub fn memory_save(
        &self,
        id: Option<String>,
        kind: String,
        content: String,
        source: String,
        expires_at: Option<String>,
        confirmed: bool,
    ) -> Result<MemoryRecord, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "保存 AI 记忆需要 confirmed=true",
            ));
        }
        let result = self
            .memories
            .save(id, &kind, &content, &source, expires_at.as_deref())
            .map_err(|error| match error {
                MemoryError::Validation(message) => ServiceError::new("VALIDATION", message),
                MemoryError::Sensitive(message) => ServiceError::new("SENSITIVE_CONTENT", message),
                MemoryError::Storage(message) => ServiceError::new("MEMORY_ERROR", message),
            })?;
        self.audit.record(
            "memory_save",
            &[
                ("id", &result.id),
                ("kind", &result.kind),
                ("source", &result.source),
            ],
        );
        Ok(result)
    }

    pub fn memory_delete(
        &self,
        id: &str,
        confirmed: bool,
    ) -> Result<serde_json::Value, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "删除 AI 记忆需要 confirmed=true",
            ));
        }
        let deleted = self
            .memories
            .delete(id)
            .map_err(|error| ServiceError::new("MEMORY_ERROR", error))?;
        if deleted {
            self.audit.record("memory_delete", &[("id", id)]);
        }
        Ok(serde_json::json!({ "id": id, "deleted": deleted }))
    }

    /// 创建笔记（契约 POST /api/notes → note_create）：
    /// confirmed 必需；client id 已存在时幂等返回详情；标题归一化 + 路径占用
    /// 递增分配；frontmatter 序列化后经统一写边界落盘（审计/快照/索引一并生效）。
    pub fn create_note(
        &self,
        id: Option<String>,
        title: Option<String>,
        content: &str,
        folder_id: Option<String>,
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
        if let Some(folder_id) = folder_id.as_deref() {
            crate::index::directory_path_for_id(&self.vault, folder_id)
                .ok_or_else(|| ServiceError::new("VALIDATION", "指定的目录不存在"))?;
        }
        let final_title = normalize_title(title.as_deref().unwrap_or(""), content);
        let file_path = self.allocate_file_path(&final_title, folder_id.as_deref())?;
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
    fn allocate_file_path(
        &self,
        title: &str,
        folder_id: Option<&str>,
    ) -> Result<String, ServiceError> {
        let base = format!("{}.md", sanitize_file_part(title, "未命名笔记"));
        let directory = folder_id
            .map(|id| {
                crate::index::directory_path_for_id(&self.vault, id)
                    .ok_or_else(|| ServiceError::new("VALIDATION", "指定的目录不存在"))
            })
            .transpose()?
            .unwrap_or_default();
        let relative_base = if directory.is_empty() {
            base.clone()
        } else {
            format!("{directory}/{base}")
        };
        let stem = relative_base.trim_end_matches(".md").to_owned();
        let mut candidate = relative_base;
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
        folder_id: Option<Option<String>>,
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
            self.audit.record(
                "update_rejected",
                &[("path", id), ("code", "CONFLICT"), ("actor", "ui")],
            );
            return Err(ServiceError::new(
                "CONFLICT",
                "笔记已在其他窗口被修改，请刷新后再保存",
            ));
        }
        // 改 content/置顶免确认；会改变文件路径的（标题/目录）需要 confirmed（契约特例）
        let title_changed = title.as_ref().is_some_and(|next| *next != current.title);
        let next_folder_id = match folder_id {
            None => current.folder_id.clone(),
            Some(value) => value,
        };
        if let Some(folder_id) = next_folder_id.as_deref() {
            crate::index::directory_path_for_id(&self.vault, folder_id)
                .ok_or_else(|| ServiceError::new("VALIDATION", "指定的目录不存在"))?;
        }
        let folder_changed = next_folder_id != current.folder_id;
        if (title_changed || folder_changed) && !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "修改标题或目录会改变文件路径，需要 confirmed=true",
            ));
        }
        let old_path = current
            .file_path
            .clone()
            .ok_or_else(|| ServiceError::new("NOTES_ERROR", "笔记缺少文件路径"))?;
        let next_title = title.unwrap_or_else(|| current.title.clone());
        let next_content = content.unwrap_or_else(|| current.content.clone());
        let next_pinned = is_pinned.unwrap_or(current.is_pinned);
        // 未提供 `properties` 时**保留**笔记现有属性（Express 语义）：
        // 否则仅改正文就会把 frontmatter 里的 status/type 等静默清空，Inbox 与属性面板随之失效
        // （P1-08 差异清单暴露）。注意 `Some(空 map)` 仍表示「显式清空」，不能与 `None` 混为一谈。
        let current_properties: serde_json::Value = current
            .properties_json
            .as_deref()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .filter(|value| value.is_object())
            .unwrap_or_else(|| serde_json::json!({}));
        let next_properties = match properties {
            Some(values) => values,
            None => current_properties.as_object().cloned().unwrap_or_default(),
        };

        let content_changed = next_content != current.content;
        let pinned_changed = next_pinned != current.is_pinned;
        let properties_changed =
            serde_json::Value::Object(next_properties.clone()) != current_properties;
        let path_changed = title_changed || folder_changed;
        if !path_changed && !content_changed && !pinned_changed && !properties_changed {
            return Ok(current); // 无变化短路
        }
        let next_path = if path_changed {
            self.allocate_file_path(&next_title, next_folder_id.as_deref())?
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
            self.write(&old_path, &raw, current.content_hash.as_deref(), "ui")?;
            let mut moved = false;
            let mut last_error = None;
            for _ in 0..3 {
                match std::fs::rename(
                    self.vault.root().join(&old_path),
                    self.vault.root().join(&next_path),
                ) {
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
                        last_error
                            .map(|error| error.to_string())
                            .unwrap_or_else(|| "未知错误".into())
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
                .upsert(
                    &next_path,
                    &raw,
                    &meta_sha256(&raw),
                    meta.bytes,
                    meta.modified_at,
                )
                .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
            self.audit.record(
                "rename",
                &[("from", &old_path), ("to", &next_path), ("actor", "ui")],
            );
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
    pub fn delete_note(
        &self,
        id: &str,
        confirmed: bool,
        second_confirmed: bool,
    ) -> Result<serde_json::Value, ServiceError> {
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
        self.audit
            .record("delete", &[("path", &path), ("actor", "ui")]);
        Ok(serde_json::json!({ "id": id, "deleted": true }))
    }

    /// 历史版本列表（契约 GET /api/notes/:id/history → note_history_list）。
    pub fn history_list(&self, id: &str) -> Result<HistoryList, ServiceError> {
        let note_id = self.require_note_id(id)?;
        let items = self
            .snapshots
            .list(&note_id)
            .into_iter()
            .map(|meta| HistoryEntry {
                version: meta.version,
                hash: meta.hash,
                created_at: meta.created_at,
                size: meta.size,
            })
            .collect();
        let current_hash = self
            .index
            .find_note_detail(Some(id), None)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            .and_then(|note| note.content_hash)
            .ok_or_else(|| ServiceError::new("NOTES_ERROR", "笔记缺少当前内容哈希"))?;
        Ok(HistoryList {
            items,
            current_hash,
        })
    }

    /// 读取历史版本内容（契约 GET /api/notes/:id/history/:version → note_history_get）。
    pub fn history_get(&self, id: &str, version: &str) -> Result<HistorySnapshot, ServiceError> {
        let note_id = self.require_note_id(id)?;
        let raw = self
            .snapshots
            .read(&note_id, version)
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "历史版本不存在或已损坏"))?;
        let (stamp, hash) = valid_version(version)
            .ok_or_else(|| ServiceError::new("VALIDATION", "历史版本标识无效"))?;
        let current = self
            .index
            .find_note_detail(Some(id), None)
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "笔记不存在"))?;
        let frontmatter = parse_frontmatter(&raw).unwrap_or_default();
        Ok(HistorySnapshot {
            version: version.to_owned(),
            hash: hash.to_owned(),
            created_at: version_created_at(stamp),
            title: frontmatter.title.unwrap_or(current.title),
            content: strip_frontmatter(&raw).to_owned(),
            is_pinned: frontmatter.pinned,
            properties: serde_json::Value::Object(frontmatter.properties),
            raw,
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
        let frontmatter = parse_frontmatter(&snapshot.raw).unwrap_or_default();
        let title = frontmatter.title.or_else(|| Some(current.title.clone()));
        let content = strip_frontmatter(&snapshot.raw).to_owned();
        let restored = self.update_note(
            id,
            title,
            Some(content),
            None,
            Some(frontmatter.pinned),
            Some(frontmatter.properties),
            current.content_hash.clone(),
            true,
        )?;
        self.audit.record(
            "restore",
            &[("path", &path), ("version", version), ("actor", "ui")],
        );
        Ok(restored)
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
        parent_id: Option<&str>,
        sort_order: Option<u64>,
        confirmed: bool,
    ) -> Result<FolderRecord, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "创建目录需要 confirmed=true",
            ));
        }
        let safe_name = sanitize_file_part(name, "未命名目录");
        let parent_path = parent_id
            .map(|id| {
                crate::index::directory_path_for_id(&self.vault, id)
                    .ok_or_else(|| ServiceError::new("NOT_FOUND", "父目录不存在"))
            })
            .transpose()?;
        let relative = match parent_path.as_deref() {
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
        self.audit
            .record("folder_create", &[("path", &relative), ("actor", "ui")]);
        let (created_at, updated_at) =
            crate::index::directory_timestamps(self.vault.root(), &relative);
        Ok(FolderRecord {
            id: crate::index::stable_folder_id(&relative),
            name: safe_name,
            parent_id: parent_path.as_deref().map(crate::index::stable_folder_id),
            sort_order: sort_order.unwrap_or(0),
            created_at,
            updated_at,
        })
    }

    /// 目录重命名/移动（契约 PATCH /api/folders/:id → folder_update）：
    /// 磁盘 rename 一次完成子树移动，投影由全量扫描自愈（笔记/链接/标签级联）。
    pub fn folder_update(
        &self,
        id: &str,
        name: Option<String>,
        parent_id: Option<Option<&str>>,
        sort_order: Option<u64>,
        confirmed: bool,
    ) -> Result<FolderRecord, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "修改目录需要 confirmed=true（会改变其下笔记路径）",
            ));
        }
        let old_path = crate::index::directory_path_for_id(&self.vault, id)
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "目录不存在"))?;
        let old_name = old_path.rsplit('/').next().unwrap_or(&old_path).to_owned();
        let parent = old_path
            .rsplit_once('/')
            .map(|(parent, _)| parent.to_owned());
        let next_name = match name.as_deref() {
            Some(next) => sanitize_file_part(next, "未命名目录"),
            None => old_name.clone(),
        };
        let requested_parent = match parent_id {
            Some(Some(id)) => Some(
                crate::index::directory_path_for_id(&self.vault, id)
                    .ok_or_else(|| ServiceError::new("NOT_FOUND", "父目录不存在"))?,
            ),
            Some(None) => None,
            None => parent,
        };
        let parent = requested_parent;
        let next_path = match parent {
            Some(parent) if !parent.is_empty() => format!("{parent}/{next_name}"),
            _ => next_name.clone(),
        };
        if next_path != old_path && next_path.starts_with(&format!("{old_path}/")) {
            return Err(ServiceError::new(
                "CONFLICT",
                "不能把目录移动到它自己或其子目录下",
            ));
        }
        if next_path == old_path {
            let (created_at, updated_at) =
                crate::index::directory_timestamps(self.vault.root(), &old_path);
            return Ok(FolderRecord {
                id: crate::index::stable_folder_id(&old_path),
                name: old_name,
                parent_id: old_path
                    .rsplit_once('/')
                    .map(|(parent, _)| crate::index::stable_folder_id(parent)),
                sort_order: sort_order.unwrap_or(0),
                created_at,
                updated_at,
            });
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
        self.audit.record(
            "folder_rename",
            &[("from", &old_path), ("to", &next_path), ("actor", "ui")],
        );
        // 投影自愈：路径变化级联 notes.folder_id / links / note_tags
        self.index
            .scan(&self.vault)
            .map_err(|error| ServiceError::new("SCAN_ERROR", error))?;
        let (created_at, updated_at) =
            crate::index::directory_timestamps(self.vault.root(), &next_path);
        Ok(FolderRecord {
            id: crate::index::stable_folder_id(&next_path),
            name: next_name,
            parent_id: next_path
                .rsplit_once('/')
                .map(|(parent, _)| crate::index::stable_folder_id(parent)),
            sort_order: sort_order.unwrap_or(0),
            created_at,
            updated_at,
        })
    }

    /// 删除目录（契约 DELETE /api/folders/:id → folder_delete）：
    /// destructive 双确认；目录下文件按 Express 语义移到 Vault 根，目录本身再删除。
    pub fn folder_delete(
        &self,
        id: &str,
        confirmed: bool,
        second_confirmed: bool,
    ) -> Result<serde_json::Value, ServiceError> {
        if !confirmed || !second_confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "删除目录需要 confirmed=true 且 secondConfirmed=true",
            ));
        }
        let path = crate::index::directory_path_for_id(&self.vault, id)
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "目录不存在"))?;
        let target = self.vault.root().join(&path);
        let mut files = Vec::new();
        collect_folder_files(&target, &path, &mut files)
            .map_err(|error| ServiceError::new("IO_ERROR", error))?;
        let mut moves: Vec<(PathBuf, PathBuf)> = Vec::new();
        let mut affected_note_count = 0u64;
        for relative in &files {
            let source = self.vault.root().join(relative);
            let source_name = relative.rsplit('/').next().unwrap_or(relative);
            let extension = posix_extname(source_name)
                .trim_start_matches('.')
                .to_ascii_lowercase();
            let target_name = if matches!(extension.as_str(), "md" | "markdown") {
                let raw = fs::read_to_string(&source)
                    .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
                affected_note_count += 1;
                format!(
                    "{}.md",
                    sanitize_file_part(
                        &crate::vault::title_from_markdown(&raw, relative),
                        "未命名笔记"
                    )
                )
            } else {
                source_name.to_owned()
            };
            let mut destination = self.vault.root().join(&target_name);
            let mut suffix = 2;
            while destination.exists() || moves.iter().any(|(_, path)| path == &destination) {
                let stem = target_name
                    .rsplit_once('.')
                    .map(|(stem, _)| stem)
                    .unwrap_or(&target_name);
                let extension = target_name
                    .rsplit_once('.')
                    .map(|(_, ext)| format!(".{ext}"))
                    .unwrap_or_default();
                destination = self
                    .vault
                    .root()
                    .join(format!("{stem} ({suffix}){extension}"));
                suffix += 1;
            }
            fc_assert_no_symlink(self.vault.root(), &source)
                .map_err(|error| ServiceError::new("VALIDATION", error))?;
            fc_assert_no_symlink(self.vault.root(), &destination)
                .map_err(|error| ServiceError::new("VALIDATION", error))?;
            if let Err(error) = fs::rename(&source, &destination) {
                for (moved_source, moved_destination) in moves.iter().rev() {
                    let _ = fs::rename(moved_destination, moved_source);
                }
                return Err(ServiceError::new(
                    "IO_ERROR",
                    format!("无法移动目录文件：{error}"),
                ));
            }
            moves.push((source, destination));
        }
        if let Err(error) = fs::remove_dir_all(&target) {
            for (source, destination) in moves.iter().rev() {
                let _ = fs::rename(destination, source);
            }
            return Err(ServiceError::new(
                "IO_ERROR",
                format!("无法删除目录：{error}"),
            ));
        }
        self.index
            .scan(&self.vault)
            .map_err(|error| ServiceError::new("SCAN_ERROR", error))?;
        self.audit
            .record("folder_delete", &[("path", &path), ("actor", "ui")]);
        Ok(serde_json::json!({
            "deletedFolderCount": 1,
            "affectedNoteCount": affected_note_count,
        }))
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
            return Err(ServiceError::new(
                "VALIDATION",
                "画布文件必须是 .canvas 后缀",
            ));
        }
        Ok(self.vault.root().join(trimmed))
    }

    /// 画布文件列表（契约 GET /api/canvas/files → canvas_list）。
    pub fn canvas_list(&self) -> Result<Vec<CanvasFileEntry>, ServiceError> {
        let mut files = Vec::new();
        fn walk(root: &Path, prefix: &str, files: &mut Vec<CanvasFileEntry>) {
            let Ok(entries) = std::fs::read_dir(root) else {
                return;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let relative = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if name.eq_ignore_ascii_case(".lattice") {
                        continue;
                    }
                    walk(&entry.path(), &relative, files);
                } else if name.to_ascii_lowercase().ends_with(".canvas") {
                    files.push(CanvasFileEntry {
                        path: relative,
                        name,
                        folder_path: prefix.to_owned(),
                    });
                }
            }
        }
        walk(self.vault.root(), "", &mut files);
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(files)
    }

    /// 读取画布（契约 GET /api/canvas → canvas_read）：缺失返回空画布，
    /// revision 为原文哈希（乐观锁基准），与 Express read 语义一致。
    pub fn canvas_read(&self, path: &str) -> Result<CanvasDocument, ServiceError> {
        let file = self.canvas_path(path)?;
        match std::fs::read_to_string(&file) {
            Ok(raw) => {
                let value: serde_json::Value = serde_json::from_str(&raw).map_err(|error| {
                    ServiceError::new("VALIDATION", format!("画布 JSON 解析失败：{error}"))
                })?;
                Ok(CanvasDocument {
                    nodes: value
                        .get("nodes")
                        .cloned()
                        .unwrap_or(serde_json::Value::Array(Vec::new())),
                    edges: value
                        .get("edges")
                        .cloned()
                        .unwrap_or(serde_json::Value::Array(Vec::new())),
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
    ) -> Result<CanvasWriteResult, ServiceError> {
        let file = self.canvas_path(path)?;
        let exists = file.exists();
        if !exists && !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "新建画布需要 confirmed=true",
            ));
        }
        // 磁盘格式对齐 Express canvas.write：`{...payload, version: 1}` + 结尾换行
        // （此前 Rust 写的画布文件缺 version 字段，两个通道写同一 Vault 时格式不一致）
        let document = serde_json::json!({ "nodes": nodes, "edges": edges, "version": 1 });
        let raw = format!(
            "{}\n",
            serde_json::to_string_pretty(&document).map_err(|error| ServiceError::new(
                "VALIDATION",
                format!("画布序列化失败：{error}")
            ))?
        );
        // 对齐 Express assertWritablePath：写盘前拒绝穿越符号链接
        fc_assert_no_symlink(self.vault.root(), &file)
            .map_err(|error| ServiceError::new("VALIDATION", error))?;
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
                file.parent()
                    .ok_or_else(|| ServiceError::new("IO_ERROR", "无效路径"))?,
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
            std::fs::write(&file, &raw)
                .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
        }
        self.audit
            .record("canvas_write", &[("path", path), ("actor", "ui")]);
        Ok(CanvasWriteResult {
            nodes: document
                .get("nodes")
                .cloned()
                .unwrap_or(serde_json::Value::Array(Vec::new())),
            edges: document
                .get("edges")
                .cloned()
                .unwrap_or(serde_json::Value::Array(Vec::new())),
            revision: checksum(raw.as_bytes()),
        })
    }

    /// 移动/重命名画布（契约 PATCH /api/canvas/file → canvas_move）。
    pub fn canvas_move(
        &self,
        from: &str,
        to: &str,
        confirmed: bool,
    ) -> Result<CanvasMoveResult, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "移动画布需要 confirmed=true",
            ));
        }
        let source = self.canvas_path(from)?;
        let target = self.canvas_path(to)?;
        if !source.exists() {
            return Err(ServiceError::new("NOT_FOUND", "画布不存在"));
        }
        // Windows 文件系统大小写不敏感：仅改大小写的重命名（画板.canvas → 画板.Canvas）
        // 会被 exists() 误判为「目标已存在」，与 Express canvas.move 一致，用同路径判定豁免
        let same_file = if cfg!(windows) {
            source.to_string_lossy().to_ascii_lowercase()
                == target.to_string_lossy().to_ascii_lowercase()
        } else {
            source == target
        };
        if !same_file && target.exists() {
            return Err(ServiceError::new("CONFLICT", "目标画布已存在"));
        }
        // 对齐 Express assertWritablePath：source 与 target 都要查
        fc_assert_no_symlink(self.vault.root(), &source)
            .map_err(|error| ServiceError::new("VALIDATION", error))?;
        fc_assert_no_symlink(self.vault.root(), &target)
            .map_err(|error| ServiceError::new("VALIDATION", error))?;
        if !same_file {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            std::fs::rename(&source, &target)
                .map_err(|error| ServiceError::new("IO_ERROR", format!("无法移动画布：{error}")))?;
        }
        self.audit.record(
            "canvas_move",
            &[("from", from), ("to", to), ("actor", "ui")],
        );
        Ok(CanvasMoveResult {
            from_path: from.to_string(),
            to_path: to.to_string(),
        })
    }

    /// 删除画布（契约 DELETE /api/canvas/file → canvas_delete）：destructive 双确认。
    /// 幂等：文件已不在磁盘（被外部删除、树列表过期）时按成功处理，让前端能清掉过期条目
    /// （对齐 Express canvas.remove）。
    pub fn canvas_delete(
        &self,
        path: &str,
        confirmed: bool,
        second_confirmed: bool,
    ) -> Result<CanvasDeleteResult, ServiceError> {
        if !confirmed || !second_confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "删除画布需要 confirmed=true 且 secondConfirmed=true",
            ));
        }
        let file = self.canvas_path(path)?;
        if !file.exists() {
            return Ok(CanvasDeleteResult {
                path: path.to_string(),
                deleted: true,
            });
        }
        fc_assert_no_symlink(self.vault.root(), &file)
            .map_err(|error| ServiceError::new("VALIDATION", error))?;
        std::fs::remove_file(&file)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法删除画布：{error}")))?;
        self.audit
            .record("canvas_delete", &[("path", path), ("actor", "ui")]);
        Ok(CanvasDeleteResult {
            path: path.to_string(),
            deleted: true,
        })
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
            return Err(ServiceError::new(
                "VALIDATION",
                "附件路径必须位于 attachments/ 下",
            ));
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
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
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
        walk(
            &self.vault.root().join(Self::ATTACHMENT_ROOT),
            Self::ATTACHMENT_ROOT,
            &mut files,
        );
        files.sort();
        files
    }

    /// 附件列表（契约 GET /api/vault/attachments → vault_attachments_list）：
    /// 文件 + 引用来源 + orphan 标记（引用派生自笔记正文）。
    pub fn attachments_list(&self) -> Result<Vec<AttachmentEntry>, ServiceError> {
        let references = self
            .collect_reference_map()
            .map_err(|error| ServiceError::new("REFERENCES_ERROR", error))?;
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
                mime_type: Self::attachment_mime(&extension).map(str::to_owned),
                modified_at: modified_iso(&metadata),
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
        mime_type: Option<&str>,
        folder: Option<&str>,
        bytes: Vec<u8>,
        confirmed: bool,
    ) -> Result<AttachmentUpload, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "上传附件需要 confirmed=true",
            ));
        }
        if bytes.is_empty() {
            return Err(ServiceError::new("VALIDATION", "附件内容不能为空"));
        }
        if bytes.len() as u64 > 25 * 1024 * 1024 {
            return Err(ServiceError::new("VALIDATION", "附件超过 25MB 上传限制"));
        }
        let folder = folder
            .unwrap_or("")
            .replace('\\', "/")
            .split('/')
            .map(|part| sanitize_file_part(part, "").trim().to_owned())
            .filter(|part| !part.is_empty() && !part.starts_with('.'))
            .take(4)
            .collect::<Vec<_>>()
            .join("/");
        let safe_name = sanitize_file_part(name.rsplit('/').next().unwrap_or(name), "attachment");
        let extension = safe_name
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        let expected_mime = vault_file_mime(&extension).ok_or_else(|| {
            ServiceError::new("VALIDATION", format!("不支持的附件格式：{extension}"))
        })?;
        if let Some(declared) = mime_type.filter(|value| !value.trim().is_empty())
            && declared != expected_mime
            && !(declared == "image/jpg" && expected_mime == "image/jpeg")
        {
            return Err(ServiceError::new(
                "VALIDATION",
                "附件类型与文件扩展名不匹配",
            ));
        }
        let stem = safe_name
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .unwrap_or(&safe_name);
        let base = if folder.is_empty() {
            Self::ATTACHMENT_ROOT.to_owned()
        } else {
            format!("{}/{folder}", Self::ATTACHMENT_ROOT)
        };
        let mut relative = format!("{base}/{safe_name}");
        let mut suffix = 2;
        while self.vault.root().join(&relative).exists() {
            let extension = safe_name
                .rsplit_once('.')
                .map(|(_, extension)| format!(".{extension}"))
                .unwrap_or_default();
            relative = format!("{base}/{stem} ({suffix}){extension}");
            suffix += 1;
        }
        let target = self.attachment_path(&relative)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fc_assert_no_symlink(self.vault.root(), &target)
            .map_err(|error| ServiceError::new("VALIDATION", error))?;
        let temporary = fc_temporary_path(&target);
        let write_result = (|| {
            fs::write(&temporary, &bytes)
                .map_err(|error| ServiceError::new("IO_ERROR", format!("无法写入附件：{error}")))?;
            fs::rename(&temporary, &target)
                .map_err(|error| ServiceError::new("IO_ERROR", format!("无法提交附件：{error}")))
        })();
        if temporary.exists() {
            let _ = fs::remove_file(&temporary);
        }
        write_result?;
        let metadata = std::fs::metadata(&target)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法读取附件：{error}")))?;
        self.audit
            .record("attachment_upload", &[("path", &relative), ("actor", "ui")]);
        Ok(AttachmentUpload {
            path: relative.clone(),
            name: relative.rsplit('/').next().unwrap_or(&relative).to_owned(),
            mime_type: expected_mime.to_owned(),
            size: metadata.len(),
            modified_at: modified_iso(&metadata),
        })
    }

    /// 删除附件（契约 DELETE /api/vault/attachments → vault_attachment_delete）：
    /// destructive 双确认；仍被引用时明确拒绝，防止静默丢引用。
    pub fn attachment_delete(
        &self,
        path: &str,
        confirmed: bool,
        second_confirmed: bool,
    ) -> Result<serde_json::Value, ServiceError> {
        if !confirmed || !second_confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "删除附件需要 confirmed=true 且 secondConfirmed=true",
            ));
        }
        let references = self
            .collect_reference_map()
            .map_err(|error| ServiceError::new("REFERENCES_ERROR", error))?;
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
        let normalized = path.trim().replace('\\', "/");
        if let Some((parent, _)) = normalized.rsplit_once('/') {
            self.remove_empty_parents(parent);
        }
        self.audit
            .record("attachment_delete", &[("path", path), ("actor", "ui")]);
        Ok(serde_json::json!({ "path": normalized, "deleted": true }))
    }

    /// 附件引用详情（契约 GET /api/vault/attachments/references → vault_attachment_references）。
    pub fn attachment_references(&self, path: &str) -> Result<AttachmentReferences, ServiceError> {
        let safe_path = path.trim().replace('\\', "/");
        let references = self
            .collect_reference_map()
            .map_err(|error| ServiceError::new("REFERENCES_ERROR", error))?;
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
            return Err(ServiceError::new(
                "VALIDATION",
                "正文长度超过 200 万字符上限",
            ));
        }
        if file_path.chars().count() > 1024 {
            return Err(ServiceError::new(
                "VALIDATION",
                "文件路径超过 1024 字符上限",
            ));
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
        Ok(AttachmentValidation {
            references,
            missing,
        })
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
            &[
                ("deleted", &deleted.len().to_string()),
                ("skipped", &skipped.len().to_string()),
            ],
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
            return Err(ServiceError::new(
                "VALIDATION",
                "文件路径必须是 Vault 内的相对路径",
            ));
        }
        if safe_path.starts_with('/')
            || safe_path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(ServiceError::new(
                "VALIDATION",
                "文件路径必须是 Vault 内的相对路径",
            ));
        }
        if !is_visible_vault_path(&safe_path) {
            return Err(ServiceError::new(
                "VALIDATION",
                "只能下载显示列表中的附件文件",
            ));
        }
        let target = self.vault.root().join(&safe_path);
        let metadata =
            std::fs::metadata(&target).map_err(|_| ServiceError::new("NOT_FOUND", "文件不存在"))?;
        if !metadata.is_file() {
            return Err(ServiceError::new("NOT_FOUND", "文件不存在"));
        }
        let bytes = std::fs::read(&target)
            .map_err(|error| ServiceError::new("IO_ERROR", format!("无法读取文件：{error}")))?;
        let extension = posix_extname(&safe_path)
            .trim_start_matches('.')
            .to_ascii_lowercase();
        Ok(VaultDownload {
            path: safe_path.clone(),
            name: safe_path
                .rsplit('/')
                .next()
                .unwrap_or(&safe_path)
                .to_owned(),
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
            let extension = posix_extname(&path)
                .trim_start_matches('.')
                .to_ascii_lowercase();
            let Some(mime) = vault_file_mime(&extension) else {
                continue;
            };
            let Ok(metadata) = std::fs::metadata(self.vault.root().join(&path)) else {
                continue;
            };
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
        let note_dir = if note_path.is_empty() {
            ""
        } else {
            posix_dirname(note_path)
        };
        let joined = if note_dir.is_empty() || note_dir == "." {
            reference.clone()
        } else {
            format!("{note_dir}/{reference}")
        };
        let root_reference = normalize_reference(&reference);
        let relative_reference = normalize_reference(&joined);
        let root_first = reference.starts_with("attachments/") || reference.starts_with('/');
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
            let Some(parent) = current.parent().map(|path| path.to_path_buf()) else {
                break;
            };
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
                let Some(position) = decoded.find(Self::ATTACHMENT_ROOT) else {
                    continue;
                };
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

// ===========================================================================
// files 命令面（契约 /api/files/* → file_read/find/grep/preview/execute/undo/log）
// 语义对齐 scripts/fc-core.mjs：读/查/搜直接读盘；写入走「预览 planHash →
// 快照快照目录 .fc/trash → 原子落盘 → 审计 .fc/audit.jsonl → undo 还原」闭环。
// 已知口径偏差（P1-08 契约对齐时校准）：文件列表排序为码点序（Express 为 locale）；
// read 的 offset/limit 按 Unicode 码点切片（JS 为 UTF-16 码元，BMP 内一致）。
// ===========================================================================

impl WorkspaceService {
    /// 契约 GET /api/files/read：按字符切片读取文件内容。
    pub fn file_read(
        &self,
        path: &str,
        offset: u64,
        limit: Option<u64>,
    ) -> Result<FileReadOutcome, ServiceError> {
        fc_guard(|| {
            let safe = fc_normalize_relative(path)?;
            let file_path = self.fc_resolve(&safe)?;
            fc_assert_regular_file(&file_path, &safe)?;
            let meta = fs::metadata(&file_path).map_err(|error| error.to_string())?;
            if meta.len() > FC_MAX_READ_INPUT_BYTES {
                return Err(format!(
                    "File too large for read ({} bytes, limit {FC_MAX_READ_INPUT_BYTES}): {safe}",
                    meta.len()
                ));
            }
            let raw = fs::read(&file_path).map_err(|error| error.to_string())?;
            // JS toString('utf8') 等价：非法字节替换为 U+FFFD，不失败
            let content = String::from_utf8_lossy(&raw);
            let characters: Vec<char> = content.chars().collect();
            let max = limit
                .unwrap_or(FC_MAX_READ_BYTES)
                .clamp(1, FC_MAX_READ_BYTES);
            let slice = if offset >= characters.len() as u64 {
                String::new()
            } else {
                let end = (offset + max).min(characters.len() as u64);
                characters[offset as usize..end as usize].iter().collect()
            };
            let consumed = offset + slice.chars().count() as u64;
            Ok(FileReadOutcome {
                path: safe,
                size: raw.len() as u64,
                offset,
                limit: max,
                eof: consumed >= characters.len() as u64,
                content: slice,
            })
        })
    }

    /// 契约 GET /api/files/find：glob 匹配 + 可选扩展名过滤，直接走文件系统。
    pub fn file_find(
        &self,
        pattern: Option<String>,
        dir: Option<String>,
        file_type: Option<String>,
    ) -> Result<FileFindOutcome, ServiceError> {
        fc_guard(|| {
            let base = self.fc_resolve_directory(dir.as_deref().unwrap_or(""))?;
            let normalized_pattern = pattern.as_deref().unwrap_or("**/*");
            let matcher = fc_glob_regex(normalized_pattern)?;
            let extension = file_type.as_deref().map(fc_normalize_extension);
            let mut items = Vec::new();
            for file_path in fc_list_files(self.vault.root(), &base) {
                let relative_path = file_path
                    .strip_prefix(self.vault.root())
                    .map_err(|_| format!("Path escapes root: {}", file_path.display()))?
                    .to_string_lossy()
                    .replace('\\', "/");
                let match_path = file_path
                    .strip_prefix(&base)
                    .map_err(|_| format!("Path escapes root: {}", file_path.display()))?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !matcher.is_match(&match_path) {
                    continue;
                }
                if let Some(expected) = &extension {
                    let actual = Path::new(&relative_path)
                        .extension()
                        .map(|part| format!(".{}", part.to_string_lossy().to_lowercase()))
                        .unwrap_or_default();
                    if &actual != expected {
                        continue;
                    }
                }
                let meta = fs::metadata(&file_path).map_err(|error| error.to_string())?;
                items.push(FileInfo {
                    path: relative_path,
                    size: meta.len(),
                    modified_at: iso8601_utc(fc_millis(meta.modified())),
                });
            }
            let total = items.len();
            Ok(FileFindOutcome {
                pattern: normalized_pattern.to_owned(),
                items,
                total,
            })
        })
    }

    /// 契约 GET /api/files/grep：逐行匹配（regex 大小写不敏感；普通文本 to_lowercase 包含）。
    pub fn file_grep(
        &self,
        query: String,
        dir: Option<String>,
        regex_flag: bool,
        file_type: Option<String>,
    ) -> Result<FileGrepOutcome, ServiceError> {
        fc_guard(move || {
            if query.is_empty() {
                return Err("A grep query is required".into());
            }
            let base = self.fc_resolve_directory(dir.as_deref().unwrap_or(""))?;
            let extension = file_type.as_deref().map(fc_normalize_extension);
            let matcher = if regex_flag {
                Some(
                    regex::RegexBuilder::new(&query)
                        .case_insensitive(true)
                        .build()
                        .map_err(|error| format!("Invalid regular expression: {error}"))?,
                )
            } else {
                None
            };
            let needle = query.to_lowercase();
            let mut items = Vec::new();
            for file_path in fc_list_files(self.vault.root(), &base) {
                let relative_path = file_path
                    .strip_prefix(self.vault.root())
                    .map_err(|_| format!("Path escapes root: {}", file_path.display()))?
                    .to_string_lossy()
                    .replace('\\', "/");
                if let Some(expected) = &extension {
                    let actual = Path::new(&relative_path)
                        .extension()
                        .map(|part| format!(".{}", part.to_string_lossy().to_lowercase()))
                        .unwrap_or_default();
                    if &actual != expected {
                        continue;
                    }
                }
                let meta = fs::metadata(&file_path).map_err(|error| error.to_string())?;
                if meta.len() > FC_MAX_GREP_BYTES {
                    continue;
                }
                let raw = fs::read(&file_path).map_err(|error| error.to_string())?;
                let content = String::from_utf8_lossy(&raw);
                for (index, line) in content.lines().enumerate() {
                    let matched = match &matcher {
                        Some(pattern) => pattern.is_match(line),
                        None => line.to_lowercase().contains(&needle),
                    };
                    if matched {
                        items.push(GrepItem {
                            path: relative_path.clone(),
                            line: index + 1,
                            text: line.to_owned(),
                        });
                    }
                }
            }
            let total = items.len();
            Ok(FileGrepOutcome {
                query,
                regex: regex_flag,
                items,
                total,
            })
        })
    }

    /// 契约 POST /api/files/preview：预览 + plan/planHash + 确认要求
    /// （单动作与 actions[]≤30 批量二态；桌面单机恒为 editor，blocked 恒 false）。
    pub fn file_preview(
        &self,
        action: Option<FileAction>,
        actions: Option<Vec<FileAction>>,
    ) -> Result<serde_json::Value, ServiceError> {
        self.file_preview_with_context(action, actions, "local-user", "editor", None)
    }

    pub fn file_preview_with_context(
        &self,
        action: Option<FileAction>,
        actions: Option<Vec<FileAction>>,
        actor: &str,
        role: &str,
        allowed_paths: Option<&[String]>,
    ) -> Result<serde_json::Value, ServiceError> {
        fc_guard(|| {
            let (normalized, is_batch) = fc_normalize_actions(action, actions)?;
            fc_authorize_actions(&normalized, role, allowed_paths)?;
            let mut data = if is_batch {
                self.fc_preview_batch(&normalized)?
            } else {
                self.fc_preview_mutation(&normalized[0])?
            };
            let plan = self.fc_plan(&normalized, None);
            let delete_count = normalized
                .iter()
                .filter(|item| item.action_type == "delete")
                .count();
            let paths: Vec<serde_json::Value> = match data
                .get("operations")
                .and_then(|operations| operations.as_array())
            {
                Some(operations) => operations
                    .iter()
                    .flat_map(|operation| {
                        operation["changes"].as_array().cloned().unwrap_or_default()
                    })
                    .filter_map(|change| change.get("fullPath").cloned())
                    .collect(),
                None => data["changes"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|change| change.get("fullPath").cloned())
                    .collect(),
            };
            data["plan"] = plan;
            data["actor"] = serde_json::json!(actor);
            data["role"] = serde_json::json!(role);
            data["blocked"] = serde_json::json!(false);
            data["confirmation"] = serde_json::json!({
                "required": normalized.iter().any(|item| FC_MUTATION_TYPES.contains(&item.action_type.as_str())),
                "secondConfirmationRequired": delete_count > 0,
                "deleteCount": delete_count,
                "itemCount": normalized.len(),
                "paths": paths,
            });
            Ok(data)
        })
    }

    /// 契约 POST /api/files/execute：confirmed + planHash（delete 另需 secondConfirmed）闸门
    /// 后执行；快照失败回滚、审计落盘、可 undo。
    pub fn file_execute(
        &self,
        action: Option<FileAction>,
        actions: Option<Vec<FileAction>>,
        confirmed: bool,
        second_confirmed: bool,
        plan_id: Option<String>,
        plan_hash: Option<String>,
    ) -> Result<serde_json::Value, ServiceError> {
        self.file_execute_with_context(
            action,
            actions,
            confirmed,
            second_confirmed,
            plan_id,
            plan_hash,
            "local-user",
            "editor",
            None,
            None,
        )
    }

    pub fn file_execute_with_context(
        &self,
        action: Option<FileAction>,
        actions: Option<Vec<FileAction>>,
        confirmed: bool,
        second_confirmed: bool,
        plan_id: Option<String>,
        plan_hash: Option<String>,
        _actor: &str,
        role: &str,
        allowed_paths: Option<&[String]>,
        idempotency_key: Option<&str>,
    ) -> Result<serde_json::Value, ServiceError> {
        fc_guard(|| {
            if !confirmed {
                return Err("File changes require explicit confirmation".into());
            }
            let plan_hash = plan_hash.ok_or("File changes require a preview plan")?;
            let (normalized, is_batch) = fc_normalize_actions(action, actions)?;
            fc_authorize_actions(&normalized, role, allowed_paths)?;
            if normalized.iter().any(|item| item.action_type == "delete") && !second_confirmed {
                return Err("Delete operations require a second confirmation".into());
            }
            let request_hash = fc_sha256_hex(
                serde_json::to_string(&serde_json::json!({
                    "actions": &normalized,
                    "planId": &plan_id,
                    "planHash": &plan_hash,
                }))
                .map_err(|error| error.to_string())?
                .as_bytes(),
            );
            let key = idempotency_key.map(str::trim).filter(|value| !value.is_empty());
            if let Some(key) = key {
                fc_validate_idempotency_key(key)?;
                if let Some(cached) = self.fc_read_idempotency(key)? {
                    if cached["requestHash"].as_str() != Some(request_hash.as_str()) {
                        return Err("Idempotency key was already used for a different file plan".into());
                    }
                    return cached
                        .get("result")
                        .cloned()
                        .ok_or_else(|| "Stored idempotency result is invalid".to_owned());
                }
            }
            let result = if is_batch {
                self.fc_mutate_batch(&normalized, plan_id.as_deref(), Some(&plan_hash))
            } else {
                self.fc_mutate_single(
                    &normalized[0],
                    plan_id.as_deref(),
                    Some(&plan_hash),
                    None,
                    None,
                )
            }?;
            if let Some(key) = key {
                self.fc_write_idempotency(key, &request_hash, &result)?;
            }
            Ok(result)
        })
    }

    /// 契约 POST /api/files/undo：按 manifest 快照逆序还原；force 跳过状态一致性校验。
    pub fn file_undo(
        &self,
        operation_id: Option<String>,
        force: bool,
    ) -> Result<serde_json::Value, ServiceError> {
        fc_guard(|| self.fc_undo(operation_id.as_deref(), force))
    }

    /// 契约 GET /api/files/log：审计日志尾部 N 条（最新在前），损坏行跳过。
    pub fn file_log(&self, limit: Option<u64>) -> Result<Vec<serde_json::Value>, ServiceError> {
        fc_guard(|| {
            let audit = self.vault.root().join(FC_INTERNAL_DIR).join("audit.jsonl");
            if !audit.exists() {
                return Ok(Vec::new());
            }
            let count = limit.unwrap_or(40).clamp(1, 500) as usize;
            let content = fs::read_to_string(&audit).map_err(|error| error.to_string())?;
            let lines: Vec<&str> = content
                .lines()
                .filter(|line| !line.trim().is_empty())
                .collect();
            let start = lines.len().saturating_sub(count);
            let mut entries = Vec::new();
            for line in lines[start..].iter().rev() {
                if let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) {
                    entries.push(entry);
                }
            }
            Ok(entries)
        })
    }

    /// 解析相对路径：normalize + 根内 + 符号链接链校验（对齐 FileStore.resolve）。
    fn fc_resolve(&self, relative: &str) -> Result<PathBuf, String> {
        let safe = fc_normalize_relative(relative)?;
        let resolved = self.vault.root().join(&safe);
        resolved
            .strip_prefix(self.vault.root())
            .map_err(|_| format!("Path escapes root: {}", resolved.display()))?;
        fc_assert_no_symlink(self.vault.root(), &resolved)?;
        Ok(resolved)
    }

    /// 解析目录相对路径（空串 = 根），存在时必须是目录（对齐 resolveDirectory）。
    fn fc_resolve_directory(&self, value: &str) -> Result<PathBuf, String> {
        let safe = if value.is_empty() || value == "." {
            String::new()
        } else {
            fc_normalize_relative(value)?
        };
        let resolved = if safe.is_empty() {
            self.vault.root().to_path_buf()
        } else {
            self.vault.root().join(&safe)
        };
        resolved
            .strip_prefix(self.vault.root())
            .map_err(|_| format!("Path escapes root: {}", resolved.display()))?;
        fc_assert_no_symlink(self.vault.root(), &resolved)?;
        if resolved.exists() {
            let meta = fs::symlink_metadata(&resolved).map_err(|error| error.to_string())?;
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "Symbolic links are not supported: {}",
                    if safe.is_empty() { "." } else { &safe }
                ));
            }
            if !meta.is_dir() {
                return Err(format!("Not a directory: {safe}"));
            }
        }
        Ok(resolved)
    }

    /// 单动作预览：changes 状态、摘要/影响文案、diff（写类）、planHash。
    fn fc_preview_mutation(&self, action: &FileAction) -> Result<serde_json::Value, String> {
        // delete 在预览时即校验目标存在（与执行同一断言），避免确认卡片整批失败看不出原因
        if action.action_type == "delete" {
            let target = self.fc_resolve(&action.path)?;
            fc_assert_regular_file(&target, &action.path)?;
        }
        let preview_paths: Vec<&str> = match action.action_type.as_str() {
            "move" | "copy" => vec![
                &action.path,
                action.target_path.as_deref().unwrap_or(&action.path),
            ],
            _ => vec![&action.path],
        };
        let mut changes = Vec::new();
        for relative in &preview_paths {
            let absolute = self.fc_resolve(relative)?;
            let before = fc_state_for(&absolute)?;
            changes.push(serde_json::json!({
                "path": relative,
                "fullPath": absolute.display().to_string(),
                "directory": absolute.parent().map(|parent| parent.display().to_string()).unwrap_or_default(),
                "before": serde_json::to_value(&before).map_err(|error| error.to_string())?,
            }));
        }
        let plan_hash = {
            let action_value = serde_json::to_value(action).map_err(|error| error.to_string())?;
            let payload =
                serde_json::json!({ "version": 1, "action": action_value, "changes": changes });
            fc_sha256_hex(
                serde_json::to_string(&payload)
                    .map_err(|error| error.to_string())?
                    .as_bytes(),
            )
        };
        let source = self.fc_resolve(&action.path)?;
        let source_missing = !changes[0]["before"]["exists"].as_bool().unwrap_or(false);
        let summary = format!(
            "{} {}{}{}",
            action.action_type,
            action.path,
            action
                .target_path
                .as_ref()
                .map(|target| format!(" -> {target}"))
                .unwrap_or_default(),
            if source_missing {
                " (source missing)"
            } else {
                ""
            },
        );
        let existing = changes
            .iter()
            .filter(|change| change["before"]["exists"].as_bool().unwrap_or(false))
            .count();
        let destination = action
            .target_path
            .as_ref()
            .map(|target| format!("，目标 {target}"))
            .unwrap_or_default();
        let scope = if changes.len() > 1 {
            format!("影响 {} 个路径", changes.len())
        } else {
            "影响 1 个路径".to_owned()
        };
        let state = if existing > 0 {
            format!("，其中 {existing} 个路径已有内容")
        } else {
            "，目标目前不存在".to_owned()
        };
        let verb = match action.action_type.as_str() {
            "delete" => "移除内容",
            "move" => "改变路径并移除原位置",
            "copy" => "新增副本",
            _ => "写入或更新内容",
        };
        let mut preview = serde_json::json!({
            "type": action.action_type,
            "path": action.path,
            "summary": summary,
            "impact": format!("{verb}{destination}；{scope}{state}"),
            "fullPath": source.display().to_string(),
            "directory": source.parent().map(|parent| parent.display().to_string()).unwrap_or_default(),
            "reversible": true,
            "requiresSecondConfirmation": action.action_type == "delete",
            "changes": changes,
            "planHash": plan_hash,
        });
        if let Some(target) = &action.target_path {
            preview["targetPath"] = serde_json::json!(target);
        }
        if matches!(
            action.action_type.as_str(),
            "create" | "write" | "append" | "edit"
        ) {
            let current = fc_read_text_if_present(&source)?;
            let next = fc_next_text(action, current.as_deref())?;
            preview["diff"] = serde_json::json!(fc_unified_diff(
                &action.path,
                current.as_deref().unwrap_or(""),
                &next
            ));
            preview["after"] = serde_json::to_value(fc_state_for_text(&next))
                .map_err(|error| error.to_string())?;
        }
        Ok(preview)
    }

    /// 批量预览：逐动作单预览 + 批量 planHash（actions + before 状态）。
    fn fc_preview_batch(&self, actions: &[FileAction]) -> Result<serde_json::Value, String> {
        let mut operations = Vec::new();
        for action in actions {
            operations.push(self.fc_preview_mutation(action)?);
        }
        let mut counts = std::collections::BTreeMap::new();
        for operation in &operations {
            *counts
                .entry(operation["type"].as_str().unwrap_or_default().to_owned())
                .or_insert(0u64) += 1;
        }
        let before: Vec<serde_json::Value> = operations
            .iter()
            .map(|operation| {
                serde_json::json!({
                    "type": operation["type"],
                    "path": operation["path"],
                    "targetPath": operation.get("targetPath"),
                    "changes": operation["changes"],
                })
            })
            .collect();
        let plan_hash = {
            let payload = serde_json::json!({ "actions": actions, "before": before });
            fc_sha256_hex(
                serde_json::to_string(&payload)
                    .map_err(|error| error.to_string())?
                    .as_bytes(),
            )
        };
        let total = operations.len();
        let breakdown = counts
            .iter()
            .map(|(kind, count)| format!("{count} {kind}"))
            .collect::<Vec<_>>()
            .join(", ");
        let summary = if breakdown.is_empty() {
            format!(
                "{total} file operation{}",
                if total == 1 { "" } else { "s" }
            )
        } else {
            format!(
                "{total} file operation{} ({breakdown})",
                if total == 1 { "" } else { "s" }
            )
        };
        Ok(serde_json::json!({
            "planHash": plan_hash,
            "total": total,
            "counts": counts,
            "summary": summary,
            "operations": operations,
        }))
    }

    /// 操作计划（对齐 createOperationPlan：version/id/actor/role/source/createdAt/actions）。
    fn fc_plan(&self, actions: &[FileAction], plan_id: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "id": plan_id.map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string()),
            "actor": "local-user",
            "role": "editor",
            "source": "files-api",
            "createdAt": iso8601_utc(now_millis()),
            "actions": actions.iter().enumerate().map(fc_plan_action).collect::<Vec<serde_json::Value>>(),
        })
    }

    /// 单动作执行：planHash 校验 → 快照 → 应用 → manifest + 审计 → 可 undo 结果。
    fn fc_mutate_single(
        &self,
        action: &FileAction,
        plan_id: Option<&str>,
        plan_hash: Option<&str>,
        batch_id: Option<&str>,
        action_id: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let preview = self.fc_preview_mutation(action)?;
        let preview_hash = preview["planHash"].as_str().unwrap_or_default().to_owned();
        if let Some(expected) = plan_hash
            && expected != preview_hash
        {
            return Err(format!(
                "Operation plan hash mismatch: expected {expected}, current {preview_hash}"
            ));
        }
        let operation_id = format!(
            "{}-{}",
            now_millis(),
            &Uuid::new_v4().simple().to_string()[..8]
        );
        let plan = self.fc_plan(std::slice::from_ref(action), plan_id);
        let plan_action_id = plan["actions"][0]["id"]
            .as_str()
            .unwrap_or("op-1")
            .to_owned();
        let plan_id_value = plan["id"].clone();
        let created_at = iso8601_utc(now_millis());
        let operation_dir = self
            .vault
            .root()
            .join(FC_INTERNAL_DIR)
            .join("trash")
            .join(&operation_id);
        let snapshot_dir = operation_dir.join("files");
        fs::create_dir_all(&snapshot_dir).map_err(|error| error.to_string())?;
        let change_paths: Vec<String> = match action.action_type.as_str() {
            "move" => vec![
                action.path.clone(),
                action
                    .target_path
                    .clone()
                    .unwrap_or_else(|| action.path.clone()),
            ],
            "copy" => vec![
                action
                    .target_path
                    .clone()
                    .unwrap_or_else(|| action.path.clone()),
            ],
            _ => vec![action.path.clone()],
        };
        let mut entries: Vec<serde_json::Value> = Vec::new();
        let mut applied = false;
        let apply_result = (|| -> Result<serde_json::Value, String> {
            for (index, relative) in change_paths.iter().enumerate() {
                entries.push(self.fc_capture_entry(relative, &snapshot_dir, index)?);
            }
            let result = self.fc_apply_action(action)?;
            applied = true;
            for entry in entries.iter_mut() {
                let absolute = self
                    .vault
                    .root()
                    .join(entry["path"].as_str().unwrap_or_default());
                entry["after"] = serde_json::to_value(fc_state_for(&absolute)?)
                    .map_err(|error| error.to_string())?;
            }
            Ok(result)
        })();
        let result = match apply_result {
            Ok(result) => result,
            Err(error) => {
                // 动作尚未落盘才清场；已落盘则保留快照目录（撤销与审计依赖它）
                if !applied {
                    let _ = fs::remove_dir_all(&operation_dir);
                }
                return Err(error);
            }
        };
        let mut manifest = serde_json::json!({
            "id": operation_id,
            "type": action.action_type,
            "path": action.path,
            "planVersion": plan["version"],
            "planId": plan_id_value,
            "createdAt": created_at,
            "entries": entries,
        });
        if let Some(target) = &action.target_path {
            manifest["targetPath"] = serde_json::json!(target);
        }
        fs::write(
            operation_dir.join("manifest.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?
            ),
        )
        .map_err(|error| error.to_string())?;
        let mut audit = serde_json::json!({
            "id": operation_id,
            "at": created_at,
            "planVersion": plan["version"],
            "planId": plan_id_value,
            "actor": "local-user",
            "role": "editor",
            "source": "files-api",
            "status": "completed",
            "type": action.action_type,
            "path": action.path,
            "targetPath": action.target_path,
            "action": fc_audit_action(action, action_id.unwrap_or(&plan_action_id)),
            "operationId": operation_id,
        });
        if let Some(batch) = batch_id {
            audit["batchId"] = serde_json::json!(batch);
        }
        self.fc_audit_append(audit)?;
        let mut outcome = serde_json::json!({
            "operationId": operation_id,
            "planId": plan_id_value,
            "planVersion": plan["version"],
            "undoable": true,
            "preview": preview,
        });
        if let serde_json::Value::Object(fields) = result {
            for (key, value) in fields {
                outcome[key] = value;
            }
        }
        Ok(outcome)
    }

    /// 批量执行：共享一个 plan，逐动作走 fc_mutate_single；中途失败终止（对齐 BATCH_PARTIAL_FAILURE 的 HTTP 语义：透传失败消息）。
    fn fc_mutate_batch(
        &self,
        actions: &[FileAction],
        plan_id: Option<&str>,
        plan_hash: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let preview = self.fc_preview_batch(actions)?;
        let preview_hash = preview["planHash"].as_str().unwrap_or_default().to_owned();
        if let Some(expected) = plan_hash
            && expected != preview_hash
        {
            return Err(format!(
                "Batch plan hash mismatch: expected {expected}, current {preview_hash}"
            ));
        }
        let batch_id = format!(
            "{}-{}",
            now_millis(),
            &Uuid::new_v4().simple().to_string()[..8]
        );
        let plan = self.fc_plan(actions, plan_id);
        let plan_id_value = plan["id"].clone();
        let mut operation_ids = Vec::new();
        let mut results = Vec::new();
        for (index, action) in actions.iter().enumerate() {
            let action_id = plan["actions"][index]["id"]
                .as_str()
                .unwrap_or("op-1")
                .to_owned();
            let result = self.fc_mutate_single(
                action,
                Some(plan_id_value.as_str().unwrap_or_default()),
                None,
                Some(&batch_id),
                Some(&action_id),
            );
            match result {
                Ok(result) => {
                    let operation_id = result["operationId"].clone();
                    operation_ids.push(operation_id.clone());
                    results.push(fc_batch_result(
                        &action_id,
                        action,
                        "completed",
                        Some(result),
                        None,
                    ));
                }
                Err(error) => {
                    results.push(fc_batch_result(
                        &action_id,
                        action,
                        "failed",
                        None,
                        Some(error.clone()),
                    ));
                    return Ok(fc_batch_outcome(
                        &batch_id,
                        &plan_id_value,
                        plan["version"].clone(),
                        &preview_hash,
                        actions.len(),
                        operation_ids.len(),
                        1,
                        true,
                        operation_ids,
                        results,
                        preview,
                        Some(error),
                    ));
                }
            }
        }
        Ok(fc_batch_outcome(
            &batch_id,
            &plan_id_value,
            plan["version"].clone(),
            &preview_hash,
            actions.len(),
            actions.len(),
            0,
            false,
            operation_ids,
            results,
            preview,
            None,
        ))
    }

    /// 撤销：找到 manifest → 状态一致性校验（force 跳过）→ 逆序还原 → 标记 undone + 审计。
    fn fc_undo(
        &self,
        operation_id: Option<&str>,
        force: bool,
    ) -> Result<serde_json::Value, String> {
        let manifest = self.fc_find_manifest(operation_id)?;
        let Some(mut manifest) = manifest else {
            return Err(match operation_id {
                Some(id) => format!("Operation not found: {id}"),
                None => "There is no operation to undo".into(),
            });
        };
        let id = manifest["id"].as_str().unwrap_or_default().to_owned();
        if manifest
            .get("undoneAt")
            .is_some_and(|value| value.is_string())
        {
            return Err(format!("Operation already undone: {id}"));
        }
        let entries = manifest["entries"].as_array().cloned().unwrap_or_default();
        if !force {
            for entry in &entries {
                let relative = entry["path"].as_str().unwrap_or_default();
                let absolute = self.fc_resolve(relative)?;
                let current = serde_json::to_value(fc_state_for(&absolute)?)
                    .map_err(|error| error.to_string())?;
                if !fc_same_state(&current, &entry["after"]) {
                    return Err(format!(
                        "Cannot undo {id}: file changed after the operation ({relative})"
                    ));
                }
            }
        }
        let operation_dir = self
            .vault
            .root()
            .join(FC_INTERNAL_DIR)
            .join("trash")
            .join(&id);
        for entry in entries.iter().rev() {
            self.fc_restore_entry(entry, &operation_dir)?;
        }
        let undone_at = iso8601_utc(now_millis());
        manifest["undoneAt"] = serde_json::json!(undone_at);
        fs::write(
            operation_dir.join("manifest.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?
            ),
        )
        .map_err(|error| error.to_string())?;
        self.fc_audit_append(serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "at": undone_at,
            "planVersion": manifest["planVersion"].as_i64().unwrap_or(1),
            "planId": manifest["planId"].as_str().unwrap_or(&id),
            "actor": "local-user",
            "role": "editor",
            "source": "files-api",
            "status": "completed",
            "type": "undo",
            "path": serde_json::Value::Null,
            "targetPath": serde_json::Value::Null,
            "action": {
                "id": serde_json::Value::Null,
                "type": "undo",
                "path": serde_json::Value::Null,
                "targetPath": serde_json::Value::Null,
            },
            "operationId": id,
        }))?;
        Ok(serde_json::json!({
            "operationId": id,
            "planId": manifest["planId"].as_str().unwrap_or(&id),
            "undone": true,
        }))
    }

    /// 快照单个受影响路径：文件复制到快照目录，目录/缺失只记状态。
    fn fc_capture_entry(
        &self,
        relative: &str,
        snapshot_dir: &Path,
        index: usize,
    ) -> Result<serde_json::Value, String> {
        let absolute = self.vault.root().join(relative);
        let before = fc_state_for(&absolute)?;
        let mut entry = serde_json::json!({
            "path": relative,
            "before": serde_json::to_value(&before).map_err(|error| error.to_string())?,
        });
        if before.kind == "file" {
            let snapshot = format!("{index}.bin");
            fs::copy(&absolute, snapshot_dir.join(&snapshot)).map_err(|error| error.to_string())?;
            entry["snapshot"] = serde_json::json!(snapshot);
        }
        Ok(entry)
    }

    /// 逆序还原单个条目：缺失→删除现物、目录→重建、文件→从快照原子写回。
    fn fc_restore_entry(
        &self,
        entry: &serde_json::Value,
        operation_dir: &Path,
    ) -> Result<(), String> {
        let relative = entry["path"]
            .as_str()
            .ok_or("manifest entry missing path")?;
        let absolute = self.vault.root().join(relative);
        absolute
            .strip_prefix(self.vault.root())
            .map_err(|_| format!("Path escapes root: {}", absolute.display()))?;
        fc_assert_no_symlink(self.vault.root(), &absolute)?;
        let before = &entry["before"];
        if before["exists"] != serde_json::json!(true) {
            if absolute.exists() {
                let meta = fs::symlink_metadata(&absolute).map_err(|error| error.to_string())?;
                if meta.is_dir() {
                    if let Err(error) = fs::remove_dir(&absolute) {
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::DirectoryNotEmpty
                                | std::io::ErrorKind::AlreadyExists
                                | std::io::ErrorKind::PermissionDenied
                        ) {
                            return Err(format!(
                                "Cannot undo: directory is not empty ({relative})"
                            ));
                        }
                        return Err(error.to_string());
                    }
                } else {
                    match fs::remove_file(&absolute) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                        Err(_) => {
                            let _ = fs::remove_file(&absolute);
                        }
                    }
                    if absolute.exists() {
                        return Err(format!(
                            "Cannot undo: file could not be removed ({relative})"
                        ));
                    }
                }
            }
            return Ok(());
        }
        if before["type"] == serde_json::json!("directory") {
            fs::create_dir_all(&absolute).map_err(|error| error.to_string())?;
            return Ok(());
        }
        let snapshot = entry["snapshot"]
            .as_str()
            .ok_or_else(|| format!("Undo snapshot is missing: {relative}"))?;
        let snapshot_path = operation_dir.join("files").join(snapshot);
        if !snapshot_path.exists() {
            return Err(format!("Undo snapshot is missing: {relative}"));
        }
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fc_write_atomic_from_file(&absolute, &snapshot_path)
    }

    /// 查 manifest：指定 id 或最近一条未撤销的（缺失/损坏一律视为没有可撤销操作）。
    fn fc_find_manifest(
        &self,
        operation_id: Option<&str>,
    ) -> Result<Option<serde_json::Value>, String> {
        let trash = self.vault.root().join(FC_INTERNAL_DIR).join("trash");
        if let Some(id) = operation_id {
            return Ok(fc_read_manifest(&trash.join(id).join("manifest.json")));
        }
        if !trash.exists() {
            return Ok(None);
        }
        let mut manifests: Vec<serde_json::Value> = fs::read_dir(&trash)
            .map_err(|error| error.to_string())?
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| fc_read_manifest(&entry.path().join("manifest.json")))
            .filter(|manifest| {
                !manifest
                    .get("undoneAt")
                    .is_some_and(|value| value.is_string())
            })
            .collect();
        manifests.sort_by(|left, right| {
            left["createdAt"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["createdAt"].as_str().unwrap_or_default())
        });
        Ok(manifests.pop())
    }

    /// 应用动作到磁盘（对齐 applyAction：存在性/类型断言 + 原子写入）。
    fn fc_apply_action(&self, action: &FileAction) -> Result<serde_json::Value, String> {
        let source = self.fc_resolve(&action.path)?;
        let target = match &action.target_path {
            Some(target) => Some(self.fc_resolve(target)?),
            None => None,
        };
        match action.action_type.as_str() {
            "mkdir" => {
                if source.exists() {
                    return Err(format!("Path already exists: {}", action.path));
                }
                fs::create_dir_all(&source).map_err(|error| error.to_string())?;
                Ok(serde_json::json!({ "path": action.path }))
            }
            "create" | "write" | "append" | "edit" => {
                if action.action_type == "create" && source.exists() {
                    return Err(format!("Path already exists: {}", action.path));
                }
                if !matches!(action.action_type.as_str(), "create" | "write") {
                    fc_assert_regular_file(&source, &action.path)?;
                }
                let current = fc_read_text_if_present(&source)?;
                let content = fc_next_text(action, current.as_deref())?;
                if let Some(parent) = source.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fc_write_atomic(&source, &content)?;
                let mut result = serde_json::json!({ "path": action.path, "size": content.len() });
                if action.action_type == "edit" {
                    let replaced = current
                        .as_deref()
                        .map(|text| text.split(action.replace.as_deref().unwrap_or("")).count() - 1)
                        .unwrap_or(0);
                    result["replaced"] = serde_json::json!(replaced);
                }
                Ok(result)
            }
            "delete" | "copy" | "move" => {
                fc_assert_regular_file(&source, &action.path)?;
                if action.action_type == "delete" {
                    fs::remove_file(&source).map_err(|error| error.to_string())?;
                    return Ok(serde_json::json!({ "path": action.path }));
                }
                let target = target
                    .ok_or_else(|| format!("{} requires a target path", action.action_type))?;
                if target.exists() {
                    return Err(format!(
                        "Target already exists: {}",
                        action.target_path.clone().unwrap_or_default()
                    ));
                }
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                if action.action_type == "copy" {
                    fs::copy(&source, &target).map_err(|error| error.to_string())?;
                } else {
                    fs::rename(&source, &target).map_err(|error| error.to_string())?;
                }
                Ok(serde_json::json!({ "fromPath": action.path, "toPath": action.target_path }))
            }
            other => Err(format!("Unsupported mutation: {other}")),
        }
    }

    /// files 审计日志：JSONL 追加到 .fc/audit.jsonl（失败即错：undo 链路依赖完整审计）。
    fn fc_audit_append(&self, entry: serde_json::Value) -> Result<(), String> {
        let audit = self.vault.root().join(FC_INTERNAL_DIR).join("audit.jsonl");
        if let Some(parent) = audit.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&audit)
            .map_err(|error| error.to_string())?;
        writeln!(
            file,
            "{}",
            serde_json::to_string(&entry).map_err(|error| error.to_string())?
        )
        .map_err(|error| error.to_string())
    }

    fn fc_read_idempotency(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        let path = self
            .vault
            .root()
            .join(FC_INTERNAL_DIR)
            .join("idempotency")
            .join(format!("{}.json", fc_sha256_hex(key.as_bytes())));
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
        Ok(serde_json::from_str(&content).ok())
    }

    fn fc_write_idempotency(
        &self,
        key: &str,
        request_hash: &str,
        result: &serde_json::Value,
    ) -> Result<(), String> {
        let directory = self.vault.root().join(FC_INTERNAL_DIR).join("idempotency");
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let path = directory.join(format!("{}.json", fc_sha256_hex(key.as_bytes())));
        let payload = serde_json::json!({ "requestHash": request_hash, "result": result });
        fc_write_atomic(
            &path,
            &format!("{}\n", serde_json::to_string(&payload).map_err(|error| error.to_string())?),
        )
    }
}

/// files 限额与内部目录（对齐 scripts/fc-core.mjs；.lattice 为 Rust 版新增内部目录，一并隐藏）。
const FC_INTERNAL_DIR: &str = ".fc";
const FC_HIDDEN_ROOT_DIRS: [&str; 2] = [".fc", ".lattice"];
const FC_MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const FC_MAX_READ_INPUT_BYTES: u64 = 64 * 1024 * 1024;
const FC_MAX_GREP_BYTES: u64 = 4 * 1024 * 1024;
const FC_MUTATION_TYPES: [&str; 8] = [
    "create", "write", "append", "edit", "copy", "move", "delete", "mkdir",
];

/// files 错误守卫：按消息短语映射契约错误码（对齐 files.service guarded）。
fn fc_guard<T>(task: impl FnOnce() -> Result<T, String>) -> Result<T, ServiceError> {
    task().map_err(|message| {
        let lower = message.to_lowercase();
        let conflict_phrases = [
            "changed after",
            "already exists",
            "already undone",
            "operation not found",
            "no operation to undo",
            "plan hash mismatch",
            "cannot undo",
        ];
        let code = if conflict_phrases.iter().any(|phrase| lower.contains(phrase)) {
            "CONFLICT"
        } else if lower.contains("does not exist")
            || lower.starts_with("not a file:")
            || lower.starts_with("not a directory:")
        {
            "NOT_FOUND"
        } else {
            "VALIDATION"
        };
        ServiceError::new(code, message)
    })
}

/// 归一 actions 输入：单动作与批量二态（批量 1..=30）。
fn fc_normalize_actions(
    action: Option<FileAction>,
    actions: Option<Vec<FileAction>>,
) -> Result<(Vec<FileAction>, bool), String> {
    if let Some(actions) = actions {
        if actions.is_empty() || actions.len() > 30 {
            return Err("Batch requires between 1 and 30 actions".into());
        }
        let normalized = actions
            .into_iter()
            .map(fc_normalize_action)
            .collect::<Result<Vec<_>, _>>()?;
        Ok((normalized, true))
    } else {
        Ok((
            vec![fc_normalize_action(
                action.ok_or("A file action is required")?,
            )?],
            false,
        ))
    }
}

/// 动作归一（对齐 normalizeAction：类型小写校验 + 按类型裁剪字段）。
fn fc_normalize_action(raw: FileAction) -> Result<FileAction, String> {
    let kind = raw.action_type.trim().to_lowercase();
    if !FC_MUTATION_TYPES.contains(&kind.as_str()) {
        let display = if kind.is_empty() {
            "(empty)"
        } else {
            kind.as_str()
        };
        return Err(format!("Unsupported mutation: {display}"));
    }
    let mut action = FileAction {
        action_type: kind.clone(),
        path: fc_normalize_relative(&raw.path)?,
        target_path: None,
        content: None,
        replace: None,
        with: None,
        all: Some(raw.all.unwrap_or(false)),
    };
    if matches!(kind.as_str(), "copy" | "move") {
        let target = raw
            .target_path
            .as_deref()
            .ok_or("A relative path is required")?;
        action.target_path = Some(fc_normalize_relative(target)?);
    }
    if matches!(kind.as_str(), "create" | "write" | "append") {
        action.content = Some(
            raw.content
                .ok_or_else(|| format!("{kind} requires --content"))?,
        );
    }
    if kind == "edit" {
        let replace = raw.replace.ok_or("edit requires --replace")?;
        if replace.is_empty() {
            return Err("edit requires --replace".into());
        }
        action.replace = Some(replace);
        action.with = Some(raw.with.ok_or("edit requires --with")?);
        action.all = Some(raw.all.unwrap_or(false));
    }
    Ok(action)
}

fn fc_authorize_actions(
    actions: &[FileAction],
    role: &str,
    allowed_paths: Option<&[String]>,
) -> Result<(), String> {
    if matches!(role.trim().to_lowercase().as_str(), "viewer" | "read-only" | "readonly") {
        return Err("Viewer role cannot execute file mutations".into());
    }
    let Some(allowed_paths) = allowed_paths else {
        return Ok(());
    };
    let scopes = allowed_paths
        .iter()
        .map(|path| fc_normalize_relative(path))
        .collect::<Result<Vec<_>, _>>()?;
    for action in actions {
        let paths = std::iter::once(&action.path).chain(action.target_path.iter());
        for path in paths {
            if !scopes
                .iter()
                .any(|scope| path == scope || path.starts_with(&format!("{scope}/")))
            {
                return Err(format!("File action exceeds the authorized path scope: {path}"));
            }
        }
    }
    Ok(())
}

fn fc_validate_idempotency_key(key: &str) -> Result<(), String> {
    if key.chars().count() > 240
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".:_-".contains(character))
    {
        return Err("Invalid idempotency key".into());
    }
    Ok(())
}

/// 相对路径归一：拒绝绝对路径/穿越/内部目录（对齐 normalizeRelativePath）。
fn fc_normalize_relative(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("A relative path is required".into());
    }
    let portable = trimmed.replace('\\', "/");
    if portable.starts_with('/') || (portable.len() >= 2 && portable.as_bytes()[1] == b':') {
        return Err(format!("Absolute paths are not allowed: {value}"));
    }
    if portable.split('/').any(|part| part == "..") {
        return Err(format!("Path traversal is not allowed: {value}"));
    }
    let normalized = portable
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        return Err(format!("Invalid relative path: {value}"));
    }
    // Windows 大小写不敏感且剥离段尾点/空格（'.FC.' 与 '.fc' 指向同一目录）
    let first = normalized
        .split('/')
        .next()
        .unwrap_or_default()
        .to_lowercase();
    if first.trim_end_matches(['.', ' ']) == FC_INTERNAL_DIR {
        return Err(format!("The {FC_INTERNAL_DIR} directory is reserved"));
    }
    Ok(normalized)
}

/// 沿父链到根做符号链接检查（对齐 assertNoSymlink）。
fn fc_assert_no_symlink(root: &Path, resolved: &Path) -> Result<(), String> {
    let mut current = resolved.to_path_buf();
    loop {
        if let Ok(meta) = fs::symlink_metadata(&current)
            && meta.file_type().is_symlink()
        {
            let display = current
                .strip_prefix(root)
                .unwrap_or(current.as_path())
                .display();
            return Err(format!("Symbolic links are not supported: {display}"));
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => break,
        }
    }
    Ok(())
}

/// 常规文件断言（对齐 assertRegularFile）。
fn fc_assert_regular_file(path: &Path, display: &str) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("File does not exist: {display}"));
        }
        Err(error) => return Err(error.to_string()),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(format!("Not a regular file: {display}"));
    }
    Ok(())
}

/// 磁盘路径状态（对齐 stateFor：missing/directory/other/file + sha256）。
fn fc_state_for(path: &Path) -> Result<FileState, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileState {
                exists: false,
                kind: "missing".into(),
                size: None,
                sha256: None,
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    if meta.file_type().is_symlink() {
        return Err(format!(
            "Symbolic links are not supported: {}",
            path.display()
        ));
    }
    if meta.is_dir() {
        return Ok(FileState {
            exists: true,
            kind: "directory".into(),
            size: None,
            sha256: None,
        });
    }
    if !meta.is_file() {
        return Ok(FileState {
            exists: true,
            kind: "other".into(),
            size: None,
            sha256: None,
        });
    }
    let data = fs::read(path).map_err(|error| error.to_string())?;
    Ok(FileState {
        exists: true,
        kind: "file".into(),
        size: Some(data.len() as u64),
        sha256: Some(fc_sha256_hex(&data)),
    })
}

/// 文本内容状态（对齐 stateForText）。
fn fc_state_for_text(content: &str) -> FileState {
    FileState {
        exists: true,
        kind: "file".into(),
        size: Some(content.len() as u64),
        sha256: Some(fc_sha256_hex(content.as_bytes())),
    }
}

/// 读取已有文本（>2MB 拒绝；目录/缺失按语义区分，对齐 readTextIfPresent）。
fn fc_read_text_if_present(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(path).map_err(|error| error.to_string())?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    if meta.len() > FC_MAX_READ_BYTES {
        return Err(format!("File is too large: {}", path.display()));
    }
    Ok(Some(
        String::from_utf8_lossy(&fs::read(path).map_err(|error| error.to_string())?).into_owned(),
    ))
}

/// 计算写入后的文本（对齐 nextText：create/write 直接覆盖、append 追加、edit 计数替换）。
fn fc_next_text(action: &FileAction, current: Option<&str>) -> Result<String, String> {
    match action.action_type.as_str() {
        "create" | "write" => Ok(action.content.clone().unwrap_or_default()),
        "append" => {
            let current =
                current.ok_or_else(|| format!("Source file does not exist: {}", action.path))?;
            Ok(format!(
                "{current}{}",
                action.content.clone().unwrap_or_default()
            ))
        }
        _ => {
            let current =
                current.ok_or_else(|| format!("Source file does not exist: {}", action.path))?;
            let replace = action.replace.as_deref().unwrap_or_default();
            let matches = current.split(replace).count() - 1;
            if matches == 0 {
                return Err(format!("Text to replace was not found in {}", action.path));
            }
            if matches > 1 && action.all != Some(true) {
                return Err(format!(
                    "Text to replace occurs {matches} times; use --all to replace all"
                ));
            }
            Ok(current
                .split(replace)
                .collect::<Vec<_>>()
                .join(action.with.as_deref().unwrap_or_default()))
        }
    }
}

/// 行级 unified diff（对齐 unifiedDiff：逐行比较，变化行 -旧 +新）。
fn fc_unified_diff(file_path: &str, before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let left: Vec<&str> = before
        .split('\n')
        .map(|line: &str| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let right: Vec<&str> = after
        .split('\n')
        .map(|line: &str| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let mut lines = vec![format!("--- {file_path}"), format!("+++ {file_path}")];
    for index in 0..left.len().max(right.len()) {
        let old = left.get(index);
        let new = right.get(index);
        if old == new {
            continue;
        }
        if let Some(line) = old {
            lines.push(format!("-{line}"));
        }
        if let Some(line) = new {
            lines.push(format!("+{line}"));
        }
    }
    lines.join("\n")
}

/// glob → 大小写不敏感正则（对齐 globToRegExp：** / → (?:.*/)?，* → [^/]*，? → [^/]）。
fn fc_glob_regex(pattern: &str) -> Result<regex::Regex, String> {
    let portable = pattern.replace('\\', "/");
    if portable.starts_with('/')
        || (portable.len() >= 2 && portable.as_bytes()[1] == b':')
        || portable.split('/').any(|part| part == "..")
    {
        return Err(format!("Invalid search pattern: {pattern}"));
    }
    let portable = portable.strip_prefix("./").unwrap_or(&portable);
    let mut source = String::from("^");
    let characters: Vec<char> = portable.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character == '*' && index + 1 < characters.len() && characters[index + 1] == '*' {
            if index + 2 < characters.len() && characters[index + 2] == '/' {
                source.push_str("(?:.*/)?");
                index += 3;
                continue;
            }
            source.push_str(".*");
            index += 2;
        } else if character == '*' {
            source.push_str("[^/]*");
            index += 1;
        } else if character == '?' {
            source.push_str("[^/]");
            index += 1;
        } else {
            if "|\\{}()[]^$+?.".contains(character) {
                source.push('\\');
            }
            source.push(character);
            index += 1;
        }
    }
    source.push('$');
    regex::RegexBuilder::new(&source)
        .case_insensitive(true)
        .build()
        .map_err(|error| error.to_string())
}

/// 递归列文件：跳过根下内部目录与符号链接，码点序排序。
fn fc_list_files(root: &Path, base: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    fc_walk(root, base, base, &mut files);
    files.sort();
    files
}

fn fc_walk(root: &Path, base: &Path, directory: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if base == root
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| FC_HIDDEN_ROOT_DIRS.contains(&name))
                .unwrap_or(false)
        {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            fc_walk(root, base, &path, out);
        } else if meta.is_file() {
            out.push(path);
        }
    }
}

/// 读 manifest（缺失/损坏一律 None，对齐 readManifest）。
fn fc_read_manifest(path: &Path) -> Option<serde_json::Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// 原子写文本：临时文件 → rename（Windows 目标已存在时回退 rm+rename）。
fn fc_write_atomic(target: &Path, content: &str) -> Result<(), String> {
    let temporary = fc_temporary_path(target);
    let result = (|| -> Result<(), String> {
        fs::write(&temporary, content).map_err(|error| error.to_string())?;
        fc_replace_file(&temporary, target)
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// 原子复制写回（undo 恢复快照用）。
fn fc_write_atomic_from_file(target: &Path, source: &Path) -> Result<(), String> {
    let temporary = fc_temporary_path(target);
    let result = (|| -> Result<(), String> {
        fs::copy(source, &temporary).map_err(|error| error.to_string())?;
        fc_replace_file(&temporary, target)
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn fc_temporary_path(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    target
        .parent()
        .unwrap_or(target)
        .join(format!("{name}.{}.tmp", Uuid::new_v4()))
}

fn fc_replace_file(source: &Path, target: &Path) -> Result<(), String> {
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(error) => {
            if target.exists() {
                fs::remove_file(target).map_err(|fallback| fallback.to_string())?;
                fs::rename(source, target).map_err(|fallback| fallback.to_string())
            } else {
                Err(error.to_string())
            }
        }
    }
}

/// plan 里的动作形状（对齐 normalizePlanActions：id + 透传字段）。
fn fc_plan_action((index, action): (usize, &FileAction)) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    object.insert("id".into(), serde_json::json!(format!("op-{}", index + 1)));
    if let Ok(serde_json::Value::Object(fields)) = serde_json::to_value(action) {
        for (key, value) in fields {
            object.insert(key, value);
        }
    }
    serde_json::Value::Object(object)
}

/// 审计里的动作摘要（对齐 auditAction：id/type/path/targetPath）。
fn fc_audit_action(action: &FileAction, action_id: &str) -> serde_json::Value {
    let mut object =
        serde_json::json!({ "id": action_id, "type": action.action_type, "path": action.path });
    if let Some(target) = &action.target_path {
        object["targetPath"] = serde_json::json!(target);
    }
    object
}

/// 状态一致性比较（对齐 sameState：exists/type/文件 sha256）。
fn fc_same_state(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    left["exists"] == right["exists"]
        && left["type"] == right["type"]
        && (left["exists"].as_bool() != Some(true)
            || left["type"].as_str() != Some("file")
            || left["sha256"] == right["sha256"])
}

fn fc_sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn fc_millis(modified: std::io::Result<std::time::SystemTime>) -> i64 {
    modified
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn fc_normalize_extension(file_type: &str) -> String {
    if file_type.starts_with('.') {
        file_type.to_lowercase()
    } else {
        format!(".{}", file_type.to_lowercase())
    }
}

/// files 动作输入（HTTP body 形状；type 为关键字以 action_type 承载）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAction {
    #[serde(rename = "type")]
    pub action_type: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub with: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all: Option<bool>,
}

/// Keep batch failure details useful for recovery without echoing write bodies.
fn fc_batch_result(
    action_id: &str,
    action: &FileAction,
    status: &str,
    result: Option<serde_json::Value>,
    error: Option<String>,
) -> serde_json::Value {
    let mut value = serde_json::json!({
        "id": action_id,
        "type": action.action_type,
        "path": action.path,
        "status": status,
    });
    if let Some(target_path) = &action.target_path {
        value["targetPath"] = serde_json::json!(target_path);
    }
    if let Some(result) = result {
        value["result"] = result;
    }
    if let Some(error) = error {
        value["error"] = serde_json::json!(error.chars().take(500).collect::<String>());
    }
    value
}

fn fc_batch_outcome(
    batch_id: &str,
    plan_id: &serde_json::Value,
    plan_version: serde_json::Value,
    plan_hash: &str,
    total: usize,
    completed: usize,
    failed: usize,
    partial_failure: bool,
    operation_ids: Vec<serde_json::Value>,
    results: Vec<serde_json::Value>,
    preview: serde_json::Value,
    failure: Option<String>,
) -> serde_json::Value {
    let compensation = serde_json::json!({
        "available": !operation_ids.is_empty(),
        "kind": "file_undo",
        "requiresConfirmation": true,
        "operationIds": operation_ids,
    });
    let mut outcome = serde_json::json!({
        "batchId": batch_id,
        "planId": plan_id,
        "planVersion": plan_version,
        "planHash": plan_hash,
        "total": total,
        "completed": completed,
        "failed": failed,
        "skipped": total.saturating_sub(completed.saturating_add(failed)),
        "partialFailure": partial_failure,
        "operationIds": compensation["operationIds"],
        "compensation": compensation,
        "results": results,
        "preview": preview,
    });
    if let Some(failure) = failure {
        outcome["failure"] = serde_json::json!({
            "message": failure.chars().take(500).collect::<String>(),
        });
    }
    outcome
}

/// files 读取结果（字符切片口径）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileReadOutcome {
    pub path: String,
    pub size: u64,
    pub offset: u64,
    pub limit: u64,
    pub eof: bool,
    pub content: String,
}

/// files find 命中条目。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub size: u64,
    pub modified_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFindOutcome {
    pub pattern: String,
    pub items: Vec<FileInfo>,
    pub total: usize,
}

/// files grep 命中行。
#[derive(Serialize)]
pub struct GrepItem {
    pub path: String,
    pub line: usize,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGrepOutcome {
    pub query: String,
    pub regex: bool,
    pub items: Vec<GrepItem>,
    pub total: usize,
}

/// 路径状态（preview changes / undo 一致性校验共用）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    pub exists: bool,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

// ===========================================================================
// experts/skills 注册表（契约 /api/experts/* → 9 命令；对齐 experts.registry.js）
// 内置资源编译期嵌入（P1-09 删 Express 时需把 builtin 资源迁至 src-tauri，Δ9）；
// 工作区层 <vault>/.lattice/experts/*.json 与 .lattice/skills/<id>/{skill.json,SKILL.md}，
// 读取 workspace 优先于 builtin；保存/删除走 confirmed（删除另需 secondConfirmed）。
// ===========================================================================

/// 内置专家（目录字典序，与 Express readdirSync 一致）。
const BUILTIN_EXPERTS: &[&str] = &[
    include_str!("../resources/builtin/experts/decision-archivist.json"),
    include_str!("../resources/builtin/experts/general.json"),
    include_str!("../resources/builtin/experts/inbox-organizer.json"),
    include_str!("../resources/builtin/experts/knowledge-curator.json"),
    include_str!("../resources/builtin/experts/knowledge-researcher.json"),
    include_str!("../resources/builtin/experts/note-editor.json"),
    include_str!("../resources/builtin/experts/task-executor.json"),
];

/// 内置技能（skill.json, SKILL.md），目录字典序。
const BUILTIN_SKILLS: &[(&str, &str)] = &[
    (
        include_str!("../resources/builtin/skills/decision-capture/skill.json"),
        include_str!("../resources/builtin/skills/decision-capture/SKILL.md"),
    ),
    (
        include_str!("../resources/builtin/skills/inbox-triage/skill.json"),
        include_str!("../resources/builtin/skills/inbox-triage/SKILL.md"),
    ),
    (
        include_str!("../resources/builtin/skills/link-graph-analysis/skill.json"),
        include_str!("../resources/builtin/skills/link-graph-analysis/SKILL.md"),
    ),
    (
        include_str!("../resources/builtin/skills/note-structure-audit/skill.json"),
        include_str!("../resources/builtin/skills/note-structure-audit/SKILL.md"),
    ),
    (
        include_str!("../resources/builtin/skills/operation-plan/skill.json"),
        include_str!("../resources/builtin/skills/operation-plan/SKILL.md"),
    ),
    (
        include_str!("../resources/builtin/skills/task-batch-planner/skill.json"),
        include_str!("../resources/builtin/skills/task-batch-planner/SKILL.md"),
    ),
    (
        include_str!("../resources/builtin/skills/task-round-discipline/skill.json"),
        include_str!("../resources/builtin/skills/task-round-discipline/SKILL.md"),
    ),
    (
        include_str!("../resources/builtin/skills/vault-health-check/skill.json"),
        include_str!("../resources/builtin/skills/vault-health-check/SKILL.md"),
    ),
    (
        include_str!("../resources/builtin/skills/vault-search/skill.json"),
        include_str!("../resources/builtin/skills/vault-search/SKILL.md"),
    ),
];

impl WorkspaceService {
    /// 契约 GET /api/experts：内置 + 工作区（同 id 工作区覆盖），无效条目跳过。
    pub fn expert_list(&self) -> Result<Vec<serde_json::Value>, ServiceError> {
        let mut entries: Vec<serde_json::Value> = Vec::new();
        for raw in BUILTIN_EXPERTS {
            if let Ok(document) = serde_json::from_str::<serde_json::Value>(raw)
                && let Ok(expert) = expert_normalize(&document, &expert_file_stem(raw), "builtin")
            {
                entries.push(expert);
            }
        }
        for path in expert_list_json_files(&self.experts_dir()) {
            if let Ok(document) = serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(&path).unwrap_or_default(),
            ) && let Ok(expert) = expert_normalize(
                &document,
                &path.file_stem().unwrap_or_default().to_string_lossy(),
                "workspace",
            ) {
                if let Some(slot) = entries.iter_mut().find(|entry| entry["id"] == expert["id"]) {
                    *slot = expert;
                } else {
                    entries.push(expert);
                }
            }
        }
        for expert in entries.iter_mut() {
            let enabled_count = expert["skills"]
                .as_array()
                .map(|skills| {
                    skills
                        .iter()
                        .filter(|skill| skill["enabled"] == serde_json::json!(true))
                        .count()
                })
                .unwrap_or(0);
            expert["skillCount"] = serde_json::json!(enabled_count);
            if let Some(skills) = expert["skills"].as_array_mut() {
                for skill in skills.iter_mut() {
                    skill["available"] = serde_json::json!(
                        self.skill_exists(skill["id"].as_str().unwrap_or_default())
                    );
                }
            }
        }
        Ok(entries)
    }

    /// 契约 GET /api/experts/:id：详情（绑定技能嵌入定义摘要）。
    pub fn expert_get(&self, id: &str) -> Result<serde_json::Value, ServiceError> {
        let mut expert = self.read_expert(id)?;
        if let Some(skills) = expert["skills"].as_array_mut() {
            for skill in skills.iter_mut() {
                skill["skill"] = self
                    .read_skill(skill["id"].as_str().unwrap_or_default(), false)
                    .unwrap_or(serde_json::Value::Null);
            }
        }
        Ok(expert)
    }

    /// 契约 POST /api/experts 与 PUT /api/experts/:id（save 复用；新建禁覆盖内置专家）。
    pub fn expert_save(
        &self,
        input: serde_json::Value,
        existing_id: Option<String>,
        confirmed: bool,
    ) -> Result<serde_json::Value, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "文件变更必须先完成确认",
            ));
        }
        let id = match &existing_id {
            Some(existing) => expert_assert_id(existing)
                .map_err(|error| ServiceError::new("VALIDATION", error))?,
            None => {
                let requested = expert_assert_id(
                    input
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                )
                .map_err(|error| ServiceError::new("VALIDATION", error))?;
                if BUILTIN_EXPERTS.iter().any(|raw| {
                    serde_json::from_str::<serde_json::Value>(raw)
                        .ok()
                        .and_then(|document| {
                            document
                                .get("id")
                                .and_then(|value| value.as_str())
                                .map(|value| value == requested)
                        })
                        .unwrap_or(false)
                }) {
                    return Err(ServiceError::new(
                        "CONFLICT",
                        "内置专家不可直接覆盖，请先复制为工作区版本",
                    ));
                }
                requested
            }
        };
        let document = expert_normalize(&input, &id, "workspace")
            .map_err(|error| ServiceError::new("VALIDATION", error))?;
        expert_write_json(&self.experts_dir().join(format!("{id}.json")), &document)?;
        self.expert_get(&id)
    }

    /// 契约 DELETE /api/experts/:id：仅删除工作区版本（双确认）。
    pub fn expert_delete(
        &self,
        id: &str,
        confirmed: bool,
        second_confirmed: bool,
    ) -> Result<serde_json::Value, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "文件变更必须先完成确认",
            ));
        }
        if !second_confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "删除操作必须完成二次确认",
            ));
        }
        let resolved =
            expert_assert_id(id).map_err(|error| ServiceError::new("VALIDATION", error))?;
        let path = self.experts_dir().join(format!("{resolved}.json"));
        if !path.exists() {
            return Err(ServiceError::new(
                "NOT_FOUND",
                format!("工作区专家「{resolved}」不存在"),
            ));
        }
        fs::remove_file(&path).map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
        Ok(serde_json::json!({ "id": resolved, "deleted": true }))
    }

    /// 契约 POST /api/experts/route：关键词命中数 ≥ ceil(threshold×2) 即建议，score = 命中×100 + priority。
    pub fn expert_route(
        &self,
        message: &str,
        exclude_id: Option<String>,
    ) -> Result<Vec<serde_json::Value>, ServiceError> {
        let text = message.to_lowercase();
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let mut candidates = Vec::new();
        for expert in self.expert_list()? {
            let id = expert["id"].as_str().unwrap_or_default();
            if id == "general"
                || Some(id) == exclude_id.as_deref()
                || expert["enabled"] != serde_json::json!(true)
            {
                continue;
            }
            let mut keywords: Vec<String> = expert["routing"]["keywords"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str())
                        .map(|item| item.trim().to_lowercase())
                        .filter(|item| !item.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            keywords.sort();
            keywords.dedup();
            if keywords.is_empty() {
                continue;
            }
            let matched: Vec<&str> = keywords
                .iter()
                .filter(|keyword| text.contains(keyword.as_str()))
                .map(String::as_str)
                .collect();
            let threshold = expert["routing"]["confidenceThreshold"]
                .as_f64()
                .unwrap_or(0.72);
            let required = ((threshold * 2.0).ceil() as usize).max(1);
            if matched.len() < required {
                continue;
            }
            let priority = expert["routing"]["priority"].as_i64().unwrap_or(50);
            candidates.push((
                matched.len() as i64 * 100 + priority,
                expert["name"].as_str().unwrap_or_default().to_owned(),
                serde_json::json!({
                    "id": id,
                    "name": expert["name"],
                    "description": expert["description"],
                    "icon": expert["icon"],
                    "matched": matched,
                }),
            ));
        }
        candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
        candidates.truncate(3);
        Ok(candidates
            .into_iter()
            .map(|(_, _, candidate)| candidate)
            .collect())
    }

    /// 契约 GET /api/experts/skills：技能目录（builtin + workspace 覆盖；filePath + contentHash，不含 content）。
    pub fn skill_list(&self) -> Result<Vec<serde_json::Value>, ServiceError> {
        let mut entries: Vec<serde_json::Value> = Vec::new();
        for (manifest, body) in BUILTIN_SKILLS {
            if let Ok(document) = serde_json::from_str::<serde_json::Value>(manifest)
                && let Some(skill) = skill_document(&document, body, "builtin")
            {
                if let Some(slot) = entries.iter_mut().find(|entry| entry["id"] == skill["id"]) {
                    *slot = skill.clone();
                } else {
                    entries.push(skill.clone());
                }
            }
        }
        if let Ok(directories) = fs::read_dir(self.skills_dir()) {
            for entry in directories.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                if let Some(skill) = self.read_skill_dir(&entry.path(), "workspace") {
                    if let Some(slot) = entries
                        .iter_mut()
                        .find(|existing| existing["id"] == skill["id"])
                    {
                        *slot = skill.clone();
                    } else {
                        entries.push(skill);
                    }
                }
            }
        }
        for skill in entries.iter_mut() {
            let skill_id = skill["id"].as_str().unwrap_or_default().to_owned();
            if let Some(object) = skill.as_object_mut() {
                object.remove("content");
                object.remove("path");
                object.insert(
                    "filePath".into(),
                    self.skills_dir()
                        .join(&skill_id)
                        .display()
                        .to_string()
                        .into(),
                );
            }
        }
        Ok(entries)
    }

    /// 契约 GET /api/experts/skills/:id：详情（含 content）。
    pub fn skill_get(&self, id: &str) -> Result<serde_json::Value, ServiceError> {
        self.read_skill(id, true)
    }

    /// 契约 POST /api/experts/skills 与 PUT /api/experts/skills/:id（save 复用；新建禁覆盖内置技能）。
    pub fn skill_save(
        &self,
        input: serde_json::Value,
        existing_id: Option<String>,
        confirmed: bool,
    ) -> Result<serde_json::Value, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "文件变更必须先完成确认",
            ));
        }
        let id = match &existing_id {
            Some(existing) => expert_assert_id(existing)
                .map_err(|error| ServiceError::new("VALIDATION", error))?,
            None => {
                let requested = expert_assert_id(
                    input
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                )
                .map_err(|error| ServiceError::new("VALIDATION", error))?;
                if BUILTIN_SKILLS.iter().any(|(manifest, _)| {
                    serde_json::from_str::<serde_json::Value>(manifest)
                        .ok()
                        .and_then(|document| {
                            document
                                .get("id")
                                .and_then(|value| value.as_str())
                                .map(|value| value == requested)
                        })
                        .unwrap_or(false)
                }) {
                    return Err(ServiceError::new(
                        "CONFLICT",
                        "内置Skill不可直接覆盖，请先复制为工作区版本",
                    ));
                }
                requested
            }
        };
        let content = input
            .get("content")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_owned();
        if content.is_empty() {
            return Err(ServiceError::new("VALIDATION", "Skill 内容不能为空"));
        }
        if content.chars().count() > SKILL_MAX_CHARS {
            return Err(ServiceError::new(
                "VALIDATION",
                format!("Skill 内容不能超过 {SKILL_MAX_CHARS} 个字符"),
            ));
        }
        let document = skill_normalize(&input, &id, "workspace")
            .map_err(|error| ServiceError::new("VALIDATION", error))?;
        let directory = self.skills_dir().join(&id);
        fs::create_dir_all(&directory)
            .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
        expert_write_json(&directory.join("skill.json"), &document)?;
        fs::write(directory.join("SKILL.md"), format!("{content}\n"))
            .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
        self.read_skill(&id, true)
    }

    /// 契约 DELETE /api/experts/skills/:id：仅删除工作区目录（双确认）。
    pub fn skill_delete(
        &self,
        id: &str,
        confirmed: bool,
        second_confirmed: bool,
    ) -> Result<serde_json::Value, ServiceError> {
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "文件变更必须先完成确认",
            ));
        }
        if !second_confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "删除操作必须完成二次确认",
            ));
        }
        let resolved =
            expert_assert_id(id).map_err(|error| ServiceError::new("VALIDATION", error))?;
        let directory = self.skills_dir().join(&resolved);
        if !directory.exists() {
            return Err(ServiceError::new(
                "NOT_FOUND",
                format!("工作区 Skill「{resolved}」不存在"),
            ));
        }
        fs::remove_dir_all(&directory)
            .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
        Ok(serde_json::json!({ "id": resolved, "deleted": true }))
    }

    fn experts_dir(&self) -> PathBuf {
        self.vault.root().join(".lattice").join("experts")
    }

    fn skills_dir(&self) -> PathBuf {
        self.vault.root().join(".lattice").join("skills")
    }

    fn skill_exists(&self, id: &str) -> bool {
        self.read_skill(id, false).is_ok()
    }

    /// 读专家文档：工作区优先，回落内置（对齐 readExpert）。
    fn read_expert(&self, id: &str) -> Result<serde_json::Value, ServiceError> {
        let resolved =
            expert_assert_id(id).map_err(|error| ServiceError::new("VALIDATION", error))?;
        let workspace = self.experts_dir().join(format!("{resolved}.json"));
        let raw = if workspace.exists() {
            fs::read_to_string(&workspace).ok()
        } else {
            BUILTIN_EXPERTS
                .iter()
                .find(|raw| {
                    serde_json::from_str::<serde_json::Value>(raw)
                        .ok()
                        .and_then(|document| {
                            document
                                .get("id")
                                .and_then(|value| value.as_str())
                                .map(|value| value == resolved)
                        })
                        .unwrap_or(false)
                })
                .map(|raw| raw.to_string())
        };
        let Some(raw) = raw else {
            return Err(ServiceError::new(
                "NOT_FOUND",
                format!("专家「{resolved}」不存在"),
            ));
        };
        let document: serde_json::Value = serde_json::from_str(&raw).map_err(|error| {
            ServiceError::new("VALIDATION", format!("无法读取配置文件：{error}"))
        })?;
        let source = if workspace.exists() {
            "workspace"
        } else {
            "builtin"
        };
        expert_normalize(&document, &resolved, source)
            .map_err(|error| ServiceError::new("VALIDATION", error))
    }

    /// 读技能文档（对齐 readSkill：workspace 优先；include_content 控制正文与 path 字段）。
    fn read_skill(
        &self,
        id: &str,
        include_content: bool,
    ) -> Result<serde_json::Value, ServiceError> {
        let resolved =
            expert_assert_id(id).map_err(|error| ServiceError::new("VALIDATION", error))?;
        let workspace_dir = self.skills_dir().join(&resolved);
        let workspace = self.read_skill_dir(&workspace_dir, "workspace");
        let builtin = BUILTIN_SKILLS.iter().find_map(|(manifest, body)| {
            let document = serde_json::from_str::<serde_json::Value>(manifest).ok()?;
            let candidate = skill_document(&document, body, "builtin")?;
            (candidate["id"].as_str() == Some(resolved.as_str())).then_some(candidate)
        });
        let skill = workspace
            .or(builtin)
            .ok_or_else(|| ServiceError::new("NOT_FOUND", format!("Skill「{resolved}」不存在")))?;
        if include_content {
            return Ok(skill);
        }
        let mut summary = skill;
        if let Some(object) = summary.as_object_mut() {
            object.remove("content");
            object.remove("path");
        }
        Ok(summary)
    }

    /// 读工作区技能目录（skill.json + SKILL.md 缺一不可；损坏条目返回 None 由目录剔除）。
    fn read_skill_dir(&self, directory: &Path, source: &str) -> Option<serde_json::Value> {
        let manifest_path = directory.join("skill.json");
        let body_path = directory.join("SKILL.md");
        if !manifest_path.exists() || !body_path.exists() {
            return None;
        }
        let body = fs::read_to_string(&body_path).ok()?;
        let body: String = body.chars().take(SKILL_MAX_CHARS).collect();
        let document =
            serde_json::from_str::<serde_json::Value>(&fs::read_to_string(manifest_path).ok()?)
                .ok()?;
        skill_document(&document, &body, source)
    }
}

const SKILL_MAX_CHARS: usize = 30_000;
const EXPERT_MAX_PROMPT_CHARS: usize = 12_000;

fn expert_id_regex() -> &'static regex::Regex {
    static REGEX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    REGEX.get_or_init(|| regex::Regex::new(r"^[a-z0-9][a-z0-9-_]{1,79}$").unwrap())
}

fn expert_assert_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if !expert_id_regex().is_match(trimmed) {
        return Err("ID 只能包含小写字母、数字、连字符和下划线".into());
    }
    Ok(trimmed.to_owned())
}

fn expert_file_stem(raw: &str) -> String {
    // include_str 路径仅用于 id 兜底；取最后一个 / 与 .json 之间的段
    let path = raw;
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".json").unwrap_or(name).to_owned()
}

fn expert_list_json_files(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .map(|extension| extension == "json")
                    .unwrap_or(false)
        })
        .collect();
    files.sort();
    files
}

fn expert_write_json(path: &Path, value: &serde_json::Value) -> Result<(), ServiceError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?;
    }
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value)
                .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))?
        ),
    )
    .map_err(|error| ServiceError::new("IO_ERROR", error.to_string()))
}

/// 字符串归一：trim + 按 Unicode 码点截断（JS slice(0, N) 的 BMP 等价）。
fn expert_clean_string(value: Option<&str>, fallback: &str, max: usize) -> String {
    let trimmed = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    trimmed.chars().take(max).collect()
}

fn expert_string_array(
    value: Option<&Vec<serde_json::Value>>,
    fallback: Vec<String>,
    max: usize,
) -> Vec<String> {
    match value {
        Some(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(|item| item.trim().to_owned()))
            .filter(|item| !item.is_empty())
            .take(max)
            .collect(),
        None => fallback,
    }
}

fn expert_string_array_strict(value: Option<&Vec<serde_json::Value>>, max: usize) -> Vec<String> {
    match value {
        Some(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .take(max)
            .collect(),
        None => Vec::new(),
    }
}

fn expert_clamp(value: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    match value {
        Some(value) if value.is_finite() => value.clamp(min, max),
        _ => fallback,
    }
}

/// 专家文档归一（对齐 normalizeExpert：默认值/截断/绑定收敛）。
fn expert_normalize(
    value: &serde_json::Value,
    id_hint: &str,
    source: &str,
) -> Result<serde_json::Value, String> {
    let id = expert_assert_id(
        value
            .get("id")
            .and_then(|item| item.as_str())
            .unwrap_or(id_hint),
    )?;
    let bindings = value
        .get("skills")
        .and_then(|item| item.as_array())
        .map(|items| {
            items
                .iter()
                .take(40)
                .filter_map(|item| {
                    let (skill_id, enabled, priority, config) = if let Some(text) = item.as_str() {
                        (text, true, 50, serde_json::json!({}))
                    } else {
                        (
                            item.get("id")
                                .and_then(|value| value.as_str())
                                .unwrap_or_default(),
                            item.get("enabled")
                                .and_then(|value| value.as_bool())
                                .unwrap_or(true),
                            expert_clamp(
                                item.get("priority").and_then(|value| value.as_f64()),
                                50.0,
                                0.0,
                                100.0,
                            ) as i64,
                            item.get("config")
                                .filter(|value| value.is_object())
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!({})),
                        )
                    };
                    expert_assert_id(skill_id).ok().map(|skill_id| {
                        serde_json::json!({
                            "id": skill_id,
                            "enabled": enabled,
                            "priority": priority,
                            "config": config,
                        })
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let capabilities = value.get("capabilities").filter(|item| item.is_object());
    let routing = value.get("routing").filter(|item| item.is_object());
    let write_policy = capabilities
        .and_then(|item| item.get("writePolicy"))
        .and_then(|item| item.as_str())
        .map(str::to_owned)
        .filter(|policy| ["disabled", "confirm", "auto"].contains(&policy.as_str()))
        .unwrap_or_else(|| "confirm".into());
    Ok(serde_json::json!({
        "id": id,
        "version": value.get("version").and_then(|item| item.as_str()).unwrap_or("1.0.0").chars().take(40).collect::<String>(),
        "name": expert_clean_string(value.get("name").and_then(|item| item.as_str()), &id, 120),
        "description": expert_clean_string(value.get("description").and_then(|item| item.as_str()), "", 500),
        "icon": expert_clean_string(value.get("icon").and_then(|item| item.as_str()), "sparkles", 40),
        "enabled": value.get("enabled").and_then(|item| item.as_bool()).unwrap_or(true),
        "systemPrompt": value.get("systemPrompt").and_then(|item| item.as_str()).unwrap_or_default().chars().take(EXPERT_MAX_PROMPT_CHARS).collect::<String>(),
        "scope": {
            "include": expert_string_array_strict(value.get("scope").and_then(|item| item.get("include")).and_then(|item| item.as_array()), 40),
            "exclude": expert_string_array_strict(value.get("scope").and_then(|item| item.get("exclude")).and_then(|item| item.as_array()), 40),
        },
        "skills": bindings,
        "capabilities": {
            "context": expert_string_array(capabilities.and_then(|item| item.get("context")).and_then(|item| item.as_array()), vec!["current-note".into(), "project".into(), "vault".into()], 20),
            "tools": expert_string_array(capabilities.and_then(|item| item.get("tools")).and_then(|item| item.as_array()), vec!["read".into(), "search".into()], 60),
            "writePolicy": write_policy,
            "maxRounds": expert_clamp(capabilities.and_then(|item| item.get("maxRounds")).and_then(|item| item.as_f64()), 6.0, 1.0, 12.0) as i64,
        },
        "routing": {
            "keywords": expert_string_array_strict(routing.and_then(|item| item.get("keywords")).and_then(|item| item.as_array()), 40),
            "priority": expert_clamp(routing.and_then(|item| item.get("priority")).and_then(|item| item.as_f64()), 50.0, 0.0, 100.0) as i64,
            "confidenceThreshold": expert_clamp(routing.and_then(|item| item.get("confidenceThreshold")).and_then(|item| item.as_f64()), 0.72, 0.0, 1.0),
        },
        "source": source,
    }))
}

/// 技能文档（manifest + content/contentHash/path，对齐 readSkillFromDir）。
fn skill_document(
    manifest: &serde_json::Value,
    body: &str,
    source: &str,
) -> Option<serde_json::Value> {
    let normalized = skill_normalize(
        manifest,
        manifest
            .get("id")
            .and_then(|item| item.as_str())
            .unwrap_or(""),
        source,
    )
    .ok()?;
    Some(serde_json::json!({
        "id": normalized["id"],
        "version": normalized["version"],
        "name": normalized["name"],
        "description": normalized["description"],
        "triggers": normalized["triggers"],
        "tools": normalized["tools"],
        "permissions": normalized["permissions"],
        "inputSchema": normalized["inputSchema"],
        "outputSchema": normalized["outputSchema"],
        "enabled": normalized["enabled"],
        "source": source,
        "content": body,
        "contentHash": fc_sha256_hex(body.as_bytes()),
        "path": format!("<builtin>/skills/{}/SKILL.md", normalized["id"].as_str().unwrap_or_default()),
    }))
}

/// 技能清单归一（对齐 normalizeSkillManifest）。
fn skill_normalize(
    value: &serde_json::Value,
    id_hint: &str,
    source: &str,
) -> Result<serde_json::Value, String> {
    let id = expert_assert_id(
        value
            .get("id")
            .and_then(|item| item.as_str())
            .unwrap_or(id_hint),
    )?;
    let schema = |key: &str| {
        value
            .get(key)
            .filter(|item| item.is_object())
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "type": "object" }))
    };
    Ok(serde_json::json!({
        "id": id,
        "version": value.get("version").and_then(|item| item.as_str()).unwrap_or("1.0.0").chars().take(40).collect::<String>(),
        "name": expert_clean_string(value.get("name").and_then(|item| item.as_str()), &id, 120),
        "description": expert_clean_string(value.get("description").and_then(|item| item.as_str()), "", 500),
        "triggers": expert_string_array(value.get("triggers").and_then(|item| item.as_array()), Vec::new(), 30),
        "tools": expert_string_array(value.get("tools").and_then(|item| item.as_array()), Vec::new(), 40),
        "permissions": expert_string_array(value.get("permissions").and_then(|item| item.as_array()), vec!["read".into()], 20),
        "inputSchema": schema("inputSchema"),
        "outputSchema": schema("outputSchema"),
        "enabled": value.get("enabled").and_then(|item| item.as_bool()).unwrap_or(true),
        "source": source,
    }))
}

// ===========================================================================
// review 知识健康（契约 /api/review/* → review_health/plan/execute；对齐 knowledge-health.service.js）
// 扫描只读；修复计划仅驻内存（TTL 15 分钟），执行前重校验 contentHash。
// 已知偏差（P1-08 校准）：finding id 用 sha256 截 12 位（Express 为 sha1，仅 id 稳定性语义）；
// 文本归一不做 NFKC；tag-alias 正文替换为朴素字符串替换（regex 无 lookbehind）；
// duplicates 删除不做 backlink 迁移（note_delete 暂无 replacementId）。
// ===========================================================================

static REPAIR_PLANS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, serde_json::Value>>> =
    std::sync::OnceLock::new();
const REVIEW_PLAN_TTL_MILLIS: i64 = 15 * 60_000;

impl WorkspaceService {
    /// 契约 GET /api/review/health：只读、可解释、可排序的知识健康报告。
    pub fn review_health(
        &self,
        stale_days: u64,
        limit: u64,
    ) -> Result<serde_json::Value, ServiceError> {
        self.health_scan(stale_days.clamp(7, 3650), limit.clamp(1, 100))
    }

    /// 契约 POST /api/review/health/plan：依据扫描结果生成修复计划（actions + manual）。
    pub fn review_plan(
        &self,
        finding_ids: Vec<String>,
        stale_days: u64,
        limit: u64,
    ) -> Result<serde_json::Value, ServiceError> {
        if finding_ids.is_empty() || finding_ids.len() > 100 {
            return Err(ServiceError::new(
                "VALIDATION",
                "一次修复计划必须包含 1-100 条线索",
            ));
        }
        let report = self.health_scan(stale_days.clamp(7, 3650), limit.clamp(1, 100))?;
        let selected: std::collections::HashSet<String> =
            finding_ids.iter().map(String::clone).collect();
        let mut selected_findings: Vec<(String, serde_json::Value)> = Vec::new();
        for (category, items) in report["categories"].as_object().into_iter().flatten() {
            for item in items.as_array().into_iter().flatten() {
                if selected.contains(item["id"].as_str().unwrap_or_default()) {
                    selected_findings.push((category.clone(), item.clone()));
                }
            }
        }
        let missing: Vec<&String> = finding_ids
            .iter()
            .filter(|id| {
                !selected_findings
                    .iter()
                    .any(|(_, item)| item["id"].as_str() == Some(id.as_str()))
            })
            .collect();
        if !missing.is_empty() {
            return Err(ServiceError::new(
                "VALIDATION",
                "部分健康线索已不在当前扫描结果中，请重新扫描后再生成计划",
            ));
        }

        let notes = self
            .index
            .list_for_health()
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
        let mut updates: HashMap<String, serde_json::Value> = HashMap::new();
        let mut deletes: Vec<serde_json::Value> = Vec::new();
        let mut manual: Vec<serde_json::Value> = Vec::new();
        let now_millis_value = now_millis();

        for (category, item) in &selected_findings {
            let category = category.as_str();
            if category == "metadata"
                && notes
                    .iter()
                    .any(|note| note.id == item["id"].as_str().unwrap_or_default())
            {
                let missing_items: Vec<String> = item["missing"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|value| value.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let note = notes
                    .iter()
                    .find(|note| note.id == item["id"].as_str().unwrap_or_default());
                let mut changed = false;
                if missing_items.iter().any(|key| key == "来源")
                    && let Some(note) = note
                {
                    let source = format!("vault:{}", note.file_path);
                    changed |= review_update_property(
                        &mut updates,
                        note,
                        now_millis_value,
                        |properties| {
                            properties.insert("source".into(), serde_json::json!(source.clone()));
                            true
                        },
                        "补全来源为当前 Vault 路径",
                    );
                }
                if missing_items.iter().any(|key| key == "标签") {
                    manual.push(serde_json::json!({
                        "findingId": item["id"], "category": category,
                        "title": item["title"], "reason": "缺少可可靠推断的标签，保留原文并等待人工选择标签",
                    }));
                }
                if missing_items.iter().any(|key| key == "时间戳") {
                    manual.push(serde_json::json!({
                        "findingId": item["id"], "category": category,
                        "title": item["title"], "reason": "时间戳缺失，不能凭推测覆盖原始时间；请人工核对文件历史",
                    }));
                }
                if !changed
                    && !missing_items
                        .iter()
                        .any(|key| key == "标签" || key == "时间戳")
                {
                    manual.push(serde_json::json!({
                        "findingId": item["id"], "category": category,
                        "title": item["title"], "reason": "没有可安全自动补全的元数据",
                    }));
                }
                continue;
            }
            if category == "taxonomy" && item["issueType"] == serde_json::json!("tag-alias") {
                let aliases: Vec<String> = item["tags"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|value| value.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let canonical = item["suggestedCanonical"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                for note_id in item["noteIds"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|value| value.as_str())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
                {
                    if let Some(note) = notes.iter().find(|note| note.id == note_id) {
                        // 属性内标签归一（数组或中/英逗号分隔字符串）
                        let raw_tags = note.properties.get("tags").cloned();
                        let tags: Vec<String> = match &raw_tags {
                            Some(serde_json::Value::Array(items)) => items
                                .iter()
                                .filter_map(|value| value.as_str().map(str::to_owned))
                                .collect(),
                            Some(serde_json::Value::String(text)) => {
                                text.split([',', '，', '、']).map(str::to_owned).collect()
                            }
                            _ => Vec::new(),
                        };
                        let normalized_tags: Vec<String> = {
                            let mut seen = std::collections::HashSet::new();
                            tags.iter()
                                .map(|tag| review_canonicalize_alias(tag, &aliases, &canonical))
                                .filter(|tag| !tag.is_empty())
                                .filter(|tag| seen.insert(tag.clone()))
                                .collect()
                        };
                        if !normalized_tags.is_empty() && normalized_tags != tags {
                            let canonical_clone = canonical.clone();
                            let normalized_clone = normalized_tags.clone();
                            review_update_property(
                                &mut updates,
                                note,
                                now_millis_value,
                                move |properties| {
                                    properties
                                        .insert("tags".into(), serde_json::json!(normalized_clone));
                                    true
                                },
                                format!("标签归一为「{canonical_clone}」"),
                            );
                        }
                        let mut content = note.content.clone();
                        for alias in &aliases {
                            if *alias != canonical {
                                content =
                                    content.replace(&format!("#{alias}"), &format!("#{canonical}"));
                            }
                        }
                        if content != note.content {
                            review_update_content(
                                &mut updates,
                                note,
                                content,
                                now_millis_value,
                                format!("正文标签归一为「{canonical}」"),
                            );
                        }
                    }
                }
                if item["noteIds"]
                    .as_array()
                    .map(|items| items.is_empty())
                    .unwrap_or(true)
                {
                    manual.push(serde_json::json!({
                        "findingId": item["id"], "category": category,
                        "title": item["title"], "reason": "没有找到受影响笔记，需人工核对标签来源",
                    }));
                }
                continue;
            }
            if category == "taxonomy" && item["issueType"] == serde_json::json!("category-alias") {
                let variants: Vec<String> = item["variants"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|value| value.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let canonical = review_choose_canonical(&variants);
                for note_id in item["noteIds"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|value| value.as_str())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
                {
                    if let Some(note) = notes.iter().find(|note| note.id == note_id) {
                        let canonical_clone = canonical.clone();
                        review_update_property(
                            &mut updates,
                            note,
                            now_millis_value,
                            move |properties| {
                                properties
                                    .insert("category".into(), serde_json::json!(canonical_clone));
                                true
                            },
                            format!("分类归一为「{canonical}」"),
                        );
                    }
                }
                if item["noteIds"]
                    .as_array()
                    .map(|items| items.is_empty())
                    .unwrap_or(true)
                {
                    manual.push(serde_json::json!({
                        "findingId": item["id"], "category": category,
                        "title": item["title"], "reason": "没有找到受影响笔记，需人工核对分类来源",
                    }));
                }
                continue;
            }
            if category == "duplicates"
                && item["evidence"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|value| value.as_str())
                            .any(|value| value.contains("标题相同"))
                            && items
                                .iter()
                                .filter_map(|value| value.as_str())
                                .any(|value| value.contains("正文高度一致"))
                    })
                    .unwrap_or(false)
            {
                // 完全重复：保留 updatedAt 最新者（相同比 id），其余进入删除
                let mut group: Vec<&crate::index::HealthNote> = item["noteIds"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|value| value.as_str())
                            .filter_map(|id| notes.iter().find(|note| note.id == id))
                            .collect()
                    })
                    .unwrap_or_default();
                group.sort_by(|left, right| {
                    right
                        .updated_at
                        .as_deref()
                        .unwrap_or_default()
                        .cmp(left.updated_at.as_deref().unwrap_or_default())
                        .then_with(|| left.id.cmp(&right.id))
                });
                let survivor = group.first().copied();
                for note in group.iter().skip(1) {
                    if Some(note.id.as_str()) == survivor.map(|note| note.id.as_str()) {
                        continue;
                    }
                    let survivor_id = survivor.map(|note| note.id.clone()).unwrap_or_default();
                    let survivor_title =
                        survivor.map(|note| note.title.clone()).unwrap_or_default();
                    deletes.push(serde_json::json!({
                        "id": format!("delete:{}", note.id),
                        "type": "delete",
                        "noteId": note.id,
                        "replacementId": survivor_id,
                        "path": note.file_path,
                        "summary": format!("删除与「{survivor_title}」完全重复的副本，并将反向链接迁移到保留笔记"),
                        "fullPath": self.vault.root().join(&note.file_path).display().to_string(),
                        "directory": self.vault.root().join(&note.file_path).parent().map(|parent| parent.display().to_string()).unwrap_or_default(),
                        "beforeHash": note.content_hash,
                        "reversible": true,
                    }));
                }
                continue;
            }
            let reason = match category {
                "duplicates" => "仅凭当前证据无法判断保留版本，暂不合并或删除",
                "conflicts" => "同名笔记内容存在差异，需要人工裁决后才能合并",
                "stale" => "过时内容不能由系统凭空改写，需要人工核对来源后更新",
                "brokenLinks" => "断链目标不明确，需人工选择创建目标或修改引用",
                "inbox" => "Inbox 归类需要结合上下文，保留在 Inbox 等待人工归档",
                "isolated" | "incomplete" => "结构调整会改变知识组织方式，暂不自动移动或补造关系",
                _ => "当前线索没有安全的自动修复动作",
            };
            manual.push(serde_json::json!({
                "findingId": item["id"], "category": category,
                "title": item.get("title").cloned().unwrap_or(item.get("targetTitle").cloned().unwrap_or(serde_json::Value::Null)),
                "reason": reason,
            }));
        }

        let mut actions: Vec<serde_json::Value> = Vec::new();
        for (note_id, state) in &updates {
            let state_changed = state["propertyChanged"] == serde_json::json!(true)
                || state["contentChanged"] == serde_json::json!(true);
            if !state_changed
                || deletes
                    .iter()
                    .any(|action| action["noteId"] == serde_json::json!(note_id.as_str()))
            {
                continue;
            }
            let note = notes.iter().find(|note| note.id == *note_id);
            let Some(note) = note else { continue };
            let mut patch = serde_json::Map::new();
            if state["contentChanged"] == serde_json::json!(true) {
                patch.insert("content".into(), state["content"].clone());
            }
            if state["propertyChanged"] == serde_json::json!(true) {
                patch.insert("properties".into(), state["properties"].clone());
            }
            patch.insert("expectedHash".into(), serde_json::json!(note.content_hash));
            actions.push(serde_json::json!({
                "id": format!("update:{note_id}"),
                "type": "update",
                "noteId": note_id,
                "path": note.file_path,
                "patch": serde_json::Value::Object(patch),
                "summary": state["summaries"]
                    .as_array()
                    .map(|items| items.iter().filter_map(|item| item.as_str()).collect::<Vec<_>>().join("；"))
                    .unwrap_or_else(|| state["summaries"].as_str().unwrap_or_default().to_owned()),
                "fullPath": self.vault.root().join(&note.file_path).display().to_string(),
                "directory": self.vault.root().join(&note.file_path).parent().map(|parent| parent.display().to_string()).unwrap_or_default(),
                "beforeHash": note.content_hash,
                "reversible": true,
            }));
        }
        actions.extend(deletes);
        let plan_id = Uuid::new_v4().to_string();
        let plan_hash = {
            let payload = serde_json::json!({ "version": 1, "actions": actions, "manual": manual });
            fc_sha256_hex(
                serde_json::to_string(&payload)
                    .map_err(|error| ServiceError::new("NOTES_ERROR", error.to_string()))?
                    .as_bytes(),
            )
        };
        let plan = serde_json::json!({
            "id": plan_id,
            "version": 1,
            "planHash": plan_hash,
            "createdAt": iso8601_utc(now_millis_value),
            "expiresAt": iso8601_utc(now_millis_value + REVIEW_PLAN_TTL_MILLIS),
            "findingIds": finding_ids,
            "actions": actions,
            "manual": manual,
        });
        review_store_plan(plan.clone());
        Ok(review_public_plan(&plan))
    }

    /// 契约 POST /api/review/health/execute：校验 plan/plashHash 与笔记版本后逐动作执行。
    pub fn review_execute(
        &self,
        plan_id: &str,
        plan_hash: &str,
        confirmed: bool,
        second_confirmed: bool,
    ) -> Result<serde_json::Value, ServiceError> {
        review_prune_plans();
        let plan = review_get_plan(plan_id).ok_or_else(|| {
            ServiceError::new("CONFLICT", "修复计划已过期，请重新生成健康修复计划")
        })?;
        if plan["planHash"].as_str().unwrap_or_default() != plan_hash {
            return Err(ServiceError::new(
                "CONFLICT",
                "修复计划已变化，请重新生成预览",
            ));
        }
        let has_delete = plan["actions"]
            .as_array()
            .map(|actions| {
                actions
                    .iter()
                    .any(|action| action["type"] == serde_json::json!("delete"))
            })
            .unwrap_or(false);
        if !confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "文件变更必须先完成确认",
            ));
        }
        if has_delete && !second_confirmed {
            return Err(ServiceError::new(
                "CONFIRMATION_REQUIRED",
                "删除操作必须完成二次确认",
            ));
        }
        let mut results = Vec::new();
        for action in plan["actions"].as_array().cloned().unwrap_or_default() {
            let note_id = action["noteId"].as_str().unwrap_or_default().to_owned();
            let summary = action["summary"].clone();
            let outcome = (|| -> Result<serde_json::Value, ServiceError> {
                let current = self
                    .index
                    .find_note_detail(Some(note_id.as_str()), None)
                    .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
                let Some(current) = current else {
                    return Err(ServiceError::new(
                        "CONFLICT",
                        "目标笔记已变化，请重新扫描后生成计划",
                    ));
                };
                if current.content_hash.as_deref().unwrap_or_default()
                    != action["beforeHash"].as_str().unwrap_or_default()
                {
                    return Err(ServiceError::new(
                        "CONFLICT",
                        "目标笔记已变化，请重新扫描后生成计划",
                    ));
                }
                if action["type"] == serde_json::json!("delete") {
                    self.delete_note(&note_id, true, true)?;
                    Ok(serde_json::json!({ "deleted": true }))
                } else {
                    let patch = &action["patch"];
                    let properties = patch
                        .get("properties")
                        .and_then(|value| value.as_object())
                        .cloned();
                    let detail = self.update_note(
                        &note_id,
                        None,
                        patch
                            .get("content")
                            .and_then(|value| value.as_str())
                            .map(str::to_owned),
                        None,
                        None,
                        properties,
                        Some(action["beforeHash"].as_str().unwrap_or_default().to_owned()),
                        true,
                    )?;
                    Ok(serde_json::to_value(detail)
                        .map_err(|error| ServiceError::new("NOTES_ERROR", error.to_string()))?)
                }
            })();
            results.push(match outcome {
                Ok(result) => serde_json::json!({
                    "id": action["id"], "type": action["type"], "path": action["path"],
                    "status": "completed", "summary": summary, "result": result,
                }),
                Err(error) => serde_json::json!({
                    "id": action["id"], "type": action["type"], "path": action["path"],
                    "status": "failed", "summary": summary, "error": error.message,
                }),
            });
        }
        let completed = results
            .iter()
            .filter(|item| item["status"] == serde_json::json!("completed"))
            .count();
        let failed = results
            .iter()
            .filter(|item| item["status"] == serde_json::json!("failed"))
            .count();
        let skipped = plan["manual"]
            .as_array()
            .map(|items| items.len())
            .unwrap_or(0);
        review_remove_plan(plan_id);
        Ok(serde_json::json!({
            "planId": plan_id,
            "actor": "local-user",
            "results": results,
            "manual": plan["manual"],
            "completed": completed,
            "failed": failed,
            "skipped": skipped,
        }))
    }

    /// 扫描主体（对齐 knowledge-health.service scan）：9 类线索 + 健康分。
    fn health_scan(&self, stale_days: u64, limit: u64) -> Result<serde_json::Value, ServiceError> {
        let notes = self
            .index
            .list_for_health()
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
        let tags = self
            .index
            .tags_for_notes()
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
        let (outgoing, incoming) = self
            .index
            .link_counts()
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
        let dangling = self
            .index
            .dangling_link_details()
            .map_err(|error| ServiceError::new("NOTES_ERROR", error))?;
        let now = now_millis();
        let limit = limit as usize;

        let note_finding = |note: &crate::index::HealthNote, extra: serde_json::Value| {
            let mut finding = serde_json::json!({
                "status": "open", "severity": "candidate", "confidence": "review", "priority": 40,
                "id": note.id, "kind": "note", "title": note.title,
                "path": note.file_path,
                // 文件路径是真源；旧索引或迁移中的行可能尚未回填 folder_id，
                // 健康报告仍按路径给出目录归属。
                "folderId": note.folder_id.clone().or_else(|| crate::index::folder_id_for(&note.file_path)),
                "updatedAt": note.updated_at, "wordCount": note.word_count,
            });
            if let (Some(target), Some(source)) = (finding.as_object_mut(), extra.as_object()) {
                for (key, value) in source {
                    target.insert(key.clone(), value.clone());
                }
            }
            finding
        };

        let inbox: Vec<serde_json::Value> = notes
            .iter()
            .filter(|note| note.properties["type"] == serde_json::json!("inbox") && note.properties["status"] != serde_json::json!("processed"))
            .map(|note| {
                let status = note.properties["status"].as_str().unwrap_or("captured").to_owned();
                note_finding(note, serde_json::json!({
                    "reason": format!("Inbox 中仍处于「{status}」状态"),
                    "inboxStatus": status,
                    "status": "open", "severity": "error", "confidence": "high", "priority": 100,
                }))
            })
            .collect();

        let mut broken_groups: std::collections::BTreeMap<String, serde_json::Value> =
            std::collections::BTreeMap::new();
        for row in &dangling {
            let key = row.target_title.to_lowercase();
            let entry = broken_groups.entry(key).or_insert_with(
                || serde_json::json!({ "targetTitle": row.target_title, "sources": [] }),
            );
            if let Some(sources) = entry["sources"].as_array_mut() {
                sources.push(serde_json::json!({ "id": row.source_id, "title": row.source_title, "path": row.source_path }));
            }
        }
        let mut broken: Vec<serde_json::Value> = broken_groups
            .into_values()
            .map(|mut group| {
                let count = group["sources"]
                    .as_array()
                    .map(|sources| sources.len())
                    .unwrap_or(0);
                let target = group["targetTitle"].clone();
                group["id"] = serde_json::json!(format!(
                    "broken-link:{}",
                    target.as_str().unwrap_or_default()
                ));
                group["kind"] = serde_json::json!("broken-link");
                group["referenceCount"] = serde_json::json!(count);
                group["reason"] = serde_json::json!(format!(
                    "有 {count} 篇笔记引用「{}」，但目标笔记尚不存在",
                    target.as_str().unwrap_or_default()
                ));
                group["status"] = serde_json::json!("open");
                group["severity"] = serde_json::json!("error");
                group["confidence"] = serde_json::json!("high");
                group["priority"] = serde_json::json!(100);
                group
            })
            .collect();
        broken.sort_by(|left, right| {
            right["referenceCount"]
                .as_i64()
                .unwrap_or(0)
                .cmp(&left["referenceCount"].as_i64().unwrap_or(0))
                .then_with(|| {
                    left["targetTitle"]
                        .as_str()
                        .unwrap_or_default()
                        .cmp(right["targetTitle"].as_str().unwrap_or_default())
                })
        });
        broken.truncate(limit);

        let isolated: Vec<serde_json::Value> = notes
            .iter()
            .filter(|note| {
                outgoing.get(&note.id).copied().unwrap_or(0) == 0
                    && incoming.get(&note.id).copied().unwrap_or(0) == 0
            })
            .map(|note| {
                note_finding(
                    note,
                    serde_json::json!({
                        "reason": "没有出链，也没有其他笔记引用它",
                        "outgoingCount": 0, "backlinkCount": 0,
                    }),
                )
            })
            .collect();

        let cutoff = now - (stale_days as i64) * 86_400_000;
        let stale: Vec<serde_json::Value> = notes
            .iter()
            .filter(|note| {
                note.properties["type"] != serde_json::json!("inbox")
                    && health_parse_iso_millis(note.updated_at.as_deref())
                        .map(|millis| millis < cutoff)
                        .unwrap_or(false)
                    && incoming.get(&note.id).copied().unwrap_or(0) == 0
            })
            .map(|note| {
                let age = health_parse_iso_millis(note.updated_at.as_deref())
                    .map(|millis| ((now - millis).max(0) / 86_400_000).max(0))
                    .unwrap_or(0);
                note_finding(
                    note,
                    serde_json::json!({
                        "reason": format!("已超过 {stale_days} 天未更新，且没有反向链接"),
                        "ageDays": age, "backlinkCount": 0,
                    }),
                )
            })
            .collect();

        // duplicates：标题归一 / 正文指纹 两条证据，同集合合并
        let mut duplicate_groups: HashMap<
            String,
            (
                Vec<&crate::index::HealthNote>,
                std::collections::HashSet<String>,
            ),
        > = HashMap::new();
        for note in &notes {
            let title_key = review_normalize_text(&note.title);
            if !title_key.is_empty() {
                let entry = duplicate_groups
                    .entry(format!("title:{title_key}"))
                    .or_insert_with(|| (Vec::new(), std::collections::HashSet::new()));
                entry.0.push(note);
                entry.1.insert("标题相同".into());
            }
            let body_key = review_body_fingerprint(&note.content);
            if !body_key.is_empty() {
                let entry = duplicate_groups
                    .entry(format!("body:{body_key}"))
                    .or_insert_with(|| (Vec::new(), std::collections::HashSet::new()));
                entry.0.push(note);
                entry.1.insert("正文高度一致".into());
            }
        }
        let mut merged: HashMap<
            String,
            (
                Vec<&crate::index::HealthNote>,
                std::collections::HashSet<String>,
            ),
        > = HashMap::new();
        for (notes_in_group, evidence) in duplicate_groups.into_values() {
            if notes_in_group.len() < 2 {
                continue;
            }
            let mut ids: Vec<&str> = notes_in_group.iter().map(|note| note.id.as_str()).collect();
            ids.sort();
            let key = ids.join("|");
            let entry = merged
                .entry(key)
                .or_insert_with(|| (notes_in_group, std::collections::HashSet::new()));
            for item in evidence {
                entry.1.insert(item);
            }
        }
        let duplicates: Vec<serde_json::Value> = merged
            .into_values()
            .take(limit)
            .map(|(group_notes, evidence)| {
                let mut ids: Vec<&str> = group_notes.iter().map(|note| note.id.as_str()).collect();
                ids.sort();
                let pair_key = ids.join("|");
                let evidence: Vec<String> = evidence.into_iter().collect();
                let confidence = if evidence.len() > 1 { "high" } else { "review" };
                let notes_payload: Vec<serde_json::Value> = group_notes
                    .iter()
                    .map(|note| note_finding(note, serde_json::json!({ "reason": evidence.join("、") })))
                    .collect();
                serde_json::json!({
                    "id": format!("duplicate:{}", &fc_sha256_hex(pair_key.as_bytes())[..12]),
                    "kind": "duplicate",
                    "noteIds": ids,
                    "notes": notes_payload,
                    "evidence": evidence,
                    "confidence": confidence,
                    "status": "open",
                    "severity": if confidence == "high" { "warning" } else { "candidate" },
                    "priority": if confidence == "high" { 75 } else { 45 },
                    "reason": if confidence == "high" { "标题与正文都高度一致".to_owned() } else { evidence.first().cloned().unwrap_or_default() },
                })
            })
            .collect();

        let conflicts: Vec<serde_json::Value> = {
            let mut groups: HashMap<String, Vec<&crate::index::HealthNote>> = HashMap::new();
            for note in &notes {
                let key = review_normalize_text(&note.title);
                if key.is_empty() {
                    continue;
                }
                groups.entry(key).or_default().push(note);
            }
            groups
                .into_values()
                .filter(|group| group.len() > 1 && {
                    let fingerprints: std::collections::HashSet<String> = group
                        .iter()
                        .map(|note| {
                            let normalized = review_normalize_text(&note.content);
                            if normalized.chars().count() < 20 { note.content.clone() } else { fc_sha256_hex(normalized.as_bytes()) }
                        })
                        .collect();
                    fingerprints.len() > 1
                })
                .take(limit)
                .map(|group| {
                    let mut ids: Vec<&str> = group.iter().map(|note| note.id.as_str()).collect();
                    ids.sort();
                    let notes_payload: Vec<serde_json::Value> = group
                        .iter()
                        .map(|note| note_finding(note, serde_json::json!({ "reason": "同名笔记正文存在差异" })))
                        .collect();
                    serde_json::json!({
                        "id": format!("conflict:{}", &fc_sha256_hex(ids.join("|").as_bytes())[..12]),
                        "kind": "conflict",
                        "noteIds": ids,
                        "notes": notes_payload,
                        "reason": format!("标题「{}」对应多个不同版本，可能是冲突而非重复", group[0].title),
                        "evidence": group.iter().map(|note| serde_json::json!({
                            "id": note.id, "path": note.file_path, "updatedAt": note.updated_at, "wordCount": note.word_count,
                        })).collect::<Vec<_>>(),
                        "status": "open", "severity": "warning", "confidence": "review", "priority": 70,
                    })
                })
                .collect()
        };

        let metadata: Vec<serde_json::Value> = notes
            .iter()
            .filter_map(|note| {
                let mut missing: Vec<&str> = Vec::new();
                if tags
                    .get(&note.id)
                    .map(|names| names.is_empty())
                    .unwrap_or(true)
                {
                    missing.push("标签");
                }
                let has_source = ["source", "来源", "origin"].iter().any(|key| {
                    note.properties
                        .get(*key)
                        .map(|value| {
                            !value.is_null()
                                && value
                                    .as_str()
                                    .map(|text| !text.trim().is_empty())
                                    .unwrap_or(true)
                        })
                        .unwrap_or(false)
                });
                if !has_source {
                    missing.push("来源");
                }
                if health_parse_iso_millis(note.created_at.as_deref()).is_none()
                    || health_parse_iso_millis(note.updated_at.as_deref()).is_none()
                {
                    missing.push("时间戳");
                }
                if missing.is_empty() {
                    return None;
                }
                let severity = if missing.contains(&"时间戳") || missing.contains(&"来源") {
                    "warning"
                } else {
                    "candidate"
                };
                Some(note_finding(
                    note,
                    serde_json::json!({
                        "kind": "metadata",
                        "missing": missing,
                        "metadata": {
                            "hasTags": !missing.contains(&"标签"),
                            "hasSource": !missing.contains(&"来源"),
                            "hasTimestamps": !missing.contains(&"时间戳"),
                        },
                        "reason": format!("缺少元数据：{}", missing.join("、")),
                        "status": "open",
                        "severity": severity,
                        "confidence": "review",
                        "priority": if severity == "warning" { 70 } else { 40 },
                    }),
                ))
            })
            .take(limit)
            .collect();

        let taxonomy: Vec<serde_json::Value> = {
            let mut findings: Vec<serde_json::Value> = Vec::new();
            // 标签别名：归一键相同的不同写法
            let mut tag_groups: HashMap<String, Vec<String>> = HashMap::new();
            for names in tags.values() {
                for name in names {
                    let key = review_normalize_taxonomy(name);
                    if key.is_empty() {
                        continue;
                    }
                    tag_groups.entry(key).or_default().push(name.clone());
                }
            }
            for (_key, mut names) in tag_groups {
                names.sort();
                names.dedup();
                if names.len() < 2 {
                    continue;
                }
                let affected: Vec<String> = notes
                    .iter()
                    .filter(|note| {
                        tags.get(&note.id)
                            .map(|note_tags| note_tags.iter().any(|name| names.contains(name)))
                            .unwrap_or(false)
                    })
                    .map(|note| note.id.clone())
                    .collect();
                let mut canonical_candidates = names.clone();
                canonical_candidates.sort_by(|left, right| {
                    left.chars()
                        .count()
                        .cmp(&right.chars().count())
                        .then_with(|| left.cmp(right))
                });
                findings.push(serde_json::json!({
                    "id": format!("taxonomy:tag:{}", review_normalize_taxonomy(&names.join("|"))),
                    "kind": "taxonomy",
                    "issueType": "tag-alias",
                    "tags": names,
                    "noteIds": affected,
                    "reason": format!("标签 {} 可能是同一概念的不同写法", names.iter().map(|name| format!("「{name}」")).collect::<Vec<_>>().join("、")),
                    "suggestedCanonical": canonical_candidates.first().cloned().unwrap_or_default(),
                    "status": "open", "severity": "warning", "confidence": "review", "priority": 70,
                }));
            }
            // 分类别名：properties.category 近似写法
            let mut category_groups: HashMap<
                String,
                (std::collections::BTreeSet<String>, Vec<String>),
            > = HashMap::new();
            for note in &notes {
                let category = note
                    .properties
                    .get("category")
                    .or_else(|| note.properties.get("分类"));
                let Some(category) = category else { continue };
                let text = match category {
                    serde_json::Value::String(text) => text.trim().to_owned(),
                    serde_json::Value::Null => continue,
                    other => other.to_string(),
                };
                if text.is_empty() {
                    continue;
                }
                let key = review_normalize_taxonomy(&text);
                if key.is_empty() {
                    continue;
                }
                let entry = category_groups
                    .entry(key)
                    .or_insert_with(|| (std::collections::BTreeSet::new(), Vec::new()));
                entry.0.insert(text);
                entry.1.push(note.id.clone());
            }
            for (key, (variants, note_ids)) in category_groups {
                if variants.len() < 2 {
                    continue;
                }
                findings.push(serde_json::json!({
                    "id": format!("taxonomy:category:{key}"),
                    "kind": "taxonomy",
                    "issueType": "category-alias",
                    "variants": variants,
                    "noteIds": note_ids,
                    "reason": format!("分类存在多个近似写法：{}", variants.iter().map(|value| format!("「{value}」")).collect::<Vec<_>>().join("、")),
                    "status": "open", "severity": "warning", "confidence": "review", "priority": 70,
                }));
            }
            findings.truncate(limit);
            findings
        };

        let system_properties = ["type", "status"];
        let incomplete: Vec<serde_json::Value> = notes
            .iter()
            .filter_map(|note| {
                let mut missing: Vec<&str> = Vec::new();
                if note.folder_id.is_none() {
                    missing.push("未归入目录");
                }
                if tags
                    .get(&note.id)
                    .map(|names| names.is_empty())
                    .unwrap_or(true)
                {
                    missing.push("没有标签");
                }
                if !note
                    .properties
                    .as_object()
                    .map(|object| {
                        object
                            .keys()
                            .any(|key| !system_properties.contains(&key.as_str()))
                    })
                    .unwrap_or(false)
                {
                    missing.push("缺少自定义属性");
                }
                if missing.is_empty() {
                    return None;
                }
                Some(note_finding(
                    note,
                    serde_json::json!({ "missing": missing, "reason": missing.join("、") }),
                ))
            })
            .take(limit)
            .collect();

        let rank = |mut items: Vec<serde_json::Value>| {
            items.sort_by(review_compare_findings);
            items.truncate(limit);
            items
        };
        let categories = serde_json::json!({
            "inbox": rank(inbox),
            "brokenLinks": rank(broken),
            "isolated": rank(isolated),
            "stale": rank(stale),
            "duplicates": rank(duplicates),
            "conflicts": rank(conflicts),
            "metadata": rank(metadata),
            "taxonomy": rank(taxonomy),
            "incomplete": rank(incomplete),
        });
        let mut findings: Vec<serde_json::Value> = Vec::new();
        for items in categories
            .as_object()
            .into_iter()
            .flat_map(|object| object.values())
        {
            findings.extend(items.as_array().cloned().unwrap_or_default());
        }
        findings.sort_by(review_compare_findings);
        let counts: serde_json::Map<String, serde_json::Value> = categories
            .as_object()
            .map(|object| {
                object
                    .iter()
                    .map(|(key, items)| {
                        (
                            key.clone(),
                            serde_json::json!(
                                items.as_array().map(|items| items.len()).unwrap_or(0)
                            ),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let hard_total = findings
            .iter()
            .filter(|item| item["severity"] == serde_json::json!("error"))
            .count();
        let warning_total = findings
            .iter()
            .filter(|item| item["severity"] == serde_json::json!("warning"))
            .count();
        let candidate_total = findings
            .iter()
            .filter(|item| item["severity"] == serde_json::json!("candidate"))
            .count();
        let weighted: i64 = findings
            .iter()
            .map(|item| {
                if item["severity"] == serde_json::json!("error") {
                    2
                } else {
                    1
                }
            })
            .sum();
        let note_count = notes.len();
        let health_score = if note_count > 0 {
            ((100.0 - (weighted as f64 / (note_count as f64 * 2.0)) * 100.0)
                .round()
                .max(0.0)) as i64
        } else {
            100
        };
        Ok(serde_json::json!({
            "scannedAt": iso8601_utc(now),
            "noteCount": note_count,
            "staleDays": stale_days,
            "limits": { "perCategory": limit },
            "summary": {
                "total": findings.len(),
                "counts": serde_json::Value::Object(counts),
                "hardTotal": hard_total,
                "warningTotal": warning_total,
                "candidateTotal": candidate_total,
                "healthScore": health_score,
                "topPriority": findings.iter().take(20).map(|item| serde_json::json!({
                    "id": item["id"], "kind": item["kind"], "priority": item["priority"],
                })).collect::<Vec<_>>(),
            },
            "categories": categories,
            "prioritized": findings.iter().take(limit.max(20)).cloned().collect::<Vec<_>>(),
        }))
    }
}

/// 修复计划内存态：存完整 plan（含 patch/beforeHash），TTL 15 分钟。
fn review_store_plan(plan: serde_json::Value) {
    let plans = REPAIR_PLANS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    if let Ok(mut guard) = plans.lock() {
        review_prune_locked(&mut guard);
        guard.insert(plan["id"].as_str().unwrap_or_default().to_owned(), plan);
    }
}

fn review_get_plan(plan_id: &str) -> Option<serde_json::Value> {
    let plans = REPAIR_PLANS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut guard = plans.lock().ok()?;
    review_prune_locked(&mut guard);
    guard.get(plan_id).cloned()
}

fn review_remove_plan(plan_id: &str) {
    if let Some(plans) = REPAIR_PLANS.get()
        && let Ok(mut guard) = plans.lock()
    {
        guard.remove(plan_id);
    }
}

fn review_prune_plans() {
    if let Some(plans) = REPAIR_PLANS.get()
        && let Ok(mut guard) = plans.lock()
    {
        review_prune_locked(&mut guard);
    }
}

fn review_prune_locked(plans: &mut HashMap<String, serde_json::Value>) {
    let now = now_millis();
    plans.retain(|_, plan| {
        health_parse_iso_millis(plan["expiresAt"].as_str())
            .map(|expires| expires > now)
            .unwrap_or(false)
    });
}

/// 对外计划形状：剥离 patch/beforeHash（对齐 publicPlan）。
fn review_public_plan(plan: &serde_json::Value) -> serde_json::Value {
    let stripped: Vec<serde_json::Value> = plan["actions"]
        .as_array()
        .map(|actions| {
            actions
                .iter()
                .map(|action| {
                    let mut copy = action.clone();
                    if let Some(object) = copy.as_object_mut() {
                        object.remove("patch");
                        object.remove("beforeHash");
                    }
                    copy
                })
                .collect()
        })
        .unwrap_or_default();
    let manual_count = plan["manual"]
        .as_array()
        .map(|items| items.len())
        .unwrap_or(0);
    let delete_count = stripped
        .iter()
        .filter(|action| action["type"] == serde_json::json!("delete"))
        .count();
    serde_json::json!({
        "id": plan["id"],
        "version": plan["version"],
        "planHash": plan["planHash"],
        "createdAt": plan["createdAt"],
        "expiresAt": plan["expiresAt"],
        "findingIds": plan["findingIds"],
        "actions": stripped,
        "changes": stripped,
        "manual": plan["manual"],
        "summary": {
            "total": stripped.len() + manual_count,
            "changes": stripped.len(),
            "manual": manual_count,
            "deletes": delete_count,
        },
        "confirmation": {
            "required": !stripped.is_empty(),
            "secondConfirmationRequired": delete_count > 0,
            "itemCount": stripped.len(),
            "deleteCount": delete_count,
            "paths": stripped.iter().filter_map(|action| action.get("fullPath").cloned()).collect::<Vec<_>>(),
        },
    })
}

/// 属性变更累积（对齐 updateProperties：无变化返回 false，不变更摘要）。
fn review_update_property(
    updates: &mut HashMap<String, serde_json::Value>,
    note: &crate::index::HealthNote,
    at: i64,
    mutate: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> bool,
    summary: impl Into<String>,
) -> bool {
    let state = review_state_for(updates, note, at);
    let before = serde_json::to_string(&state["properties"]).unwrap_or_default();
    let Some(object) = state["properties"].as_object_mut() else {
        return false;
    };
    if !mutate(object) {
        return false;
    }
    let after = serde_json::to_string(&state["properties"]).unwrap_or_default();
    if before == after {
        return false;
    }
    state["propertyChanged"] = serde_json::json!(true);
    if let Some(summaries) = state["summaries"].as_array_mut() {
        summaries.push(serde_json::json!(summary.into()));
    }
    true
}

/// 内容变更累积（对齐 updateContent）。
fn review_update_content(
    updates: &mut HashMap<String, serde_json::Value>,
    note: &crate::index::HealthNote,
    next: String,
    at: i64,
    summary: impl Into<String>,
) -> bool {
    let state = review_state_for(updates, note, at);
    if state["content"] == serde_json::json!(next) {
        return false;
    }
    state["content"] = serde_json::json!(next);
    state["contentChanged"] = serde_json::json!(true);
    if let Some(summaries) = state["summaries"].as_array_mut() {
        summaries.push(serde_json::json!(summary.into()));
    }
    true
}

fn review_state_for<'a>(
    updates: &'a mut HashMap<String, serde_json::Value>,
    note: &crate::index::HealthNote,
    at: i64,
) -> &'a mut serde_json::Value {
    updates.entry(note.id.clone()).or_insert_with(|| {
        serde_json::json!({
            "noteId": note.id,
            "path": note.file_path,
            "beforeHash": note.content_hash,
            "properties": note.properties.clone(),
            "content": note.content,
            "propertyChanged": false,
            "contentChanged": false,
            "summaries": [],
            "at": at,
        })
    })
}

fn review_choose_canonical(values: &[String]) -> String {
    let mut sorted: Vec<&String> = values.iter().collect();
    sorted.sort_by(|left, right| {
        left.chars()
            .count()
            .cmp(&right.chars().count())
            .then_with(|| left.cmp(right))
    });
    sorted
        .first()
        .map(|value| (*value).clone())
        .unwrap_or_default()
}

fn review_canonicalize_alias(value: &str, aliases: &[String], canonical: &str) -> String {
    let source = value.trim().trim_start_matches('#').to_owned();
    let matches = aliases
        .iter()
        .any(|alias| review_normalize_taxonomy(alias) == review_normalize_taxonomy(&source));
    if matches {
        canonical.to_owned()
    } else {
        source
    }
}

/// 文本归一：小写 + 去空白/标点/符号（无 NFKC，偏差见块注释）。
fn review_normalize_text(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| !character.is_whitespace() && !is_punctuation_or_symbol(*character))
        .collect()
}

fn is_punctuation_or_symbol(character: char) -> bool {
    matches!(
        character,
        ' ' | '\t'
            | '\n'
            | '\r'
            | '，'
            | '。'
            | '、'
            | '；'
            | '：'
            | '「'
            | '」'
            | '（'
            | '）'
            | '！'
            | '？'
            | '·'
    ) || character.is_ascii_punctuation()
}

/// 分类/标签归一：小写 + 去空白与分隔符。
fn review_normalize_taxonomy(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|character| {
            !character.is_whitespace() && !matches!(character, '_' | '-' | '/' | '\\')
        })
        .collect()
}

/// 正文指纹（≥8 字符才参与重复检测）。
fn review_body_fingerprint(content: &str) -> String {
    let normalized = review_normalize_text(content);
    if normalized.chars().count() < 8 {
        return String::new();
    }
    fc_sha256_hex(normalized.as_bytes())
}

/// ISO-8601 UTC → 毫秒（仅支持本项目的 `YYYY-MM-DDTHH:MM:SS.mmmZ` 口径）。
fn health_parse_iso_millis(value: Option<&str>) -> Option<i64> {
    let value = value?;
    let digits: Vec<i64> = value
        .chars()
        .filter_map(|character| character.to_digit(10).map(|digit| digit as i64))
        .collect();
    if digits.len() < 14 {
        return None;
    }
    let year = digits[0] * 1000 + digits[1] * 100 + digits[2] * 10 + digits[3];
    let month = digits[4] * 10 + digits[5];
    let day = digits[6] * 10 + digits[7];
    let hour = digits[8] * 10 + digits[9];
    let minute = digits[10] * 10 + digits[11];
    let second = digits[12] * 10 + digits[13];
    let millisecond = digits.get(14).copied().unwrap_or(0) * 100
        + digits.get(15).copied().unwrap_or(0) * 10
        + digits.get(16).copied().unwrap_or(0);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Howard Hinnant days_from_civil
    let year_adjusted = if month <= 2 { year - 1 } else { year };
    let era = if year_adjusted >= 0 {
        year_adjusted
    } else {
        year_adjusted - 399
    } / 400;
    let year_of_era = year_adjusted - era * 400;
    let month_prime = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some((days * 86_400 + hour * 3600 + minute * 60 + second) * 1000 + millisecond)
}

/// 线索排序：priority 降序 → updatedAt 升序 → id 升序。
fn review_compare_findings(
    left: &serde_json::Value,
    right: &serde_json::Value,
) -> std::cmp::Ordering {
    right["priority"]
        .as_i64()
        .unwrap_or(0)
        .cmp(&left["priority"].as_i64().unwrap_or(0))
        .then_with(|| {
            left["updatedAt"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["updatedAt"].as_str().unwrap_or_default())
        })
        .then_with(|| {
            left["id"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["id"].as_str().unwrap_or_default())
        })
}

/// 附件条目（对齐 Express listAttachments，camelCase 序列化）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime_type: Option<String>,
    pub modified_at: Option<String>,
    pub referenced_by: Vec<ReferenceSource>,
    pub orphan: bool,
}

/// 上传附件结果（对齐 Express uploadAttachment）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUpload {
    pub path: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub modified_at: Option<String>,
}

/// 文件夹写入结果（对齐 Express create/updateFolder；目录树节点另有 children/noteCount）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderRecord {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: u64,
    pub created_at: String,
    pub updated_at: String,
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

/// 画布文件条目（对齐 Express `GET /api/canvas/files`）。
///
/// 原先只回 `Vec<String>`（纯路径），而前端 `CanvasFileSummary` 消费 `path/name/folderPath`
/// 三个字段——这是 P1-08 差异清单里 `canvas_list` 的 4 条差异来源。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFileEntry {
    pub path: String,
    /// 文件名（含 `.canvas` 扩展名）
    pub name: String,
    /// 所在目录的相对路径；根目录为空串
    pub folder_path: String,
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

/// Recursively enumerate files under a folder for folder-delete relocation.
/// Symlinks are ignored so a destructive operation cannot move data outside the Vault.
fn collect_folder_files(
    directory: &Path,
    relative: &str,
    files: &mut Vec<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_relative = format!("{relative}/{name}");
        if file_type.is_dir() {
            collect_folder_files(&entry.path(), &child_relative, files)?;
        } else if file_type.is_file() {
            files.push(child_relative);
        }
    }
    Ok(())
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
    let Ok(children) = std::fs::read_dir(directory) else {
        return;
    };
    for child in children.flatten() {
        let name = child.file_name().to_string_lossy().into_owned();
        if name.starts_with('.')
            || name.ends_with(".tmp")
            || name.eq_ignore_ascii_case("node_modules")
        {
            continue;
        }
        let Ok(file_type) = child.file_type() else {
            continue;
        };
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
        let extension = posix_extname(&name)
            .trim_start_matches('.')
            .to_ascii_lowercase();
        if is_note_extension(&extension) {
            continue;
        }
        let absolute = child.path();
        let Ok(relative) = absolute.strip_prefix(root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let Ok(metadata) = child.metadata() else {
            continue;
        };
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

/// 历史版本列表（对齐 Express listHistory）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryList {
    pub items: Vec<HistoryEntry>,
    pub current_hash: String,
}

/// 历史版本内容（对齐 Express readSnapshot）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    pub version: String,
    pub hash: String,
    pub created_at: Option<String>,
    pub title: String,
    pub content: String,
    pub is_pinned: bool,
    pub properties: serde_json::Value,
    /// 仅供恢复流程使用；不暴露给 IPC，避免与 Express 的版本响应泄漏 raw。
    #[serde(skip)]
    pub raw: String,
}

/// 画布文档（对齐 Express canvas read，nodes/edges 为 Obsidian 兼容 JSON）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDocument {
    pub nodes: serde_json::Value,
    pub edges: serde_json::Value,
    pub revision: Option<String>,
}

/// 画布写入结果（对齐 Express `canvas.write`：回显 payload + revision）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CanvasWriteResult {
    pub nodes: serde_json::Value,
    pub edges: serde_json::Value,
    pub revision: String,
}

/// 画布移动结果（对齐 Express `canvas.move`）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CanvasMoveResult {
    pub from_path: String,
    pub to_path: String,
}

/// 画布删除结果（对齐 Express `canvas.remove`）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDeleteResult {
    pub path: String,
    pub deleted: bool,
}

#[cfg(test)]
mod tests {
    use super::{BUILTIN_EXPERTS, BUILTIN_SKILLS};
    use super::{FileAction, SNAPSHOT_LIMIT, ServiceError, WorkspaceService, fc_batch_outcome};

    fn open_service(directory: &Path) -> WorkspaceService {
        WorkspaceService::open(directory.to_path_buf()).unwrap()
    }

    use std::fs;
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
    fn mcp_project_missing_file_returns_default_without_starting_servers() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());

        let state = service.mcp_project_get().unwrap();

        assert_eq!(state.status, "default");
        assert!(state.warning.is_none());
        assert!(state.servers.is_empty());
        assert!(Path::new(&state.path).starts_with(service.path()));
        assert!(
            state.path.ends_with(".lattice\\mcp.json") || state.path.ends_with(".lattice/mcp.json")
        );
    }

    #[test]
    fn mcp_project_set_requires_confirmation_and_persists_normalized_document() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let document = serde_json::json!({
            "mcpServers": {
                " git ": {
                    "name": " Git ",
                    "description": "repo",
                    "command": " uvx ",
                    "args": ["mcp-server-git", 42],
                    "env": {"TOKEN": "secret", "INVALID": 42},
                    "enabled": false
                }
            }
        });

        let error = service
            .mcp_project_set(document.clone(), false)
            .unwrap_err();
        assert_eq!(error.code, "CONFIRMATION_REQUIRED");

        let saved = service.mcp_project_set(document, true).unwrap();
        assert_eq!(saved.status, "loaded");
        assert!(saved.warning.is_none());
        assert_eq!(saved.servers.len(), 1);
        assert_eq!(saved.servers[0].key, "git");
        assert_eq!(saved.servers[0].command, "uvx");
        assert_eq!(saved.servers[0].args, vec!["mcp-server-git"]);
        assert_eq!(
            saved.servers[0].env.get("TOKEN"),
            Some(&"secret".to_owned())
        );
        assert!(!saved.servers[0].enabled);

        let raw = fs::read_to_string(directory.path().join(".lattice").join("mcp.json")).unwrap();
        let persisted: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(persisted["mcpServers"]["git"]["command"], "uvx");
        assert!(persisted["mcpServers"]["git"].get("url").is_none());
    }

    #[test]
    fn mcp_project_filters_invalid_entries_and_reports_dropped_count() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let document = serde_json::json!({
            "stdio-missing-command": {"args": ["ignored"]},
            "sse-invalid-url": {"transport": "sse", "url": "file:///tmp/mcp"},
            "remote": {"url": "HtTpS://example.test/mcp", "name": "Remote"}
        });

        let saved = service.mcp_project_set(document, true).unwrap();

        assert_eq!(saved.servers.len(), 1);
        assert_eq!(saved.servers[0].key, "remote");
        assert_eq!(saved.servers[0].transport, "sse");
        assert_eq!(
            saved.warning.as_deref(),
            Some("2 个无效条目已被忽略（缺 command / URL 非法等）。")
        );
    }

    #[test]
    fn mcp_project_read_reports_invalid_json_without_overwriting_it() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let path = directory.path().join(".lattice").join("mcp.json");
        fs::write(&path, "{not-json").unwrap();

        let state = service.mcp_project_get().unwrap();

        assert_eq!(state.status, "invalid");
        assert!(state.warning.as_deref().unwrap().contains("JSON 解析失败"));
        assert!(state.servers.is_empty());
        assert_eq!(fs::read_to_string(path).unwrap(), "{not-json");
    }

    #[test]
    fn mcp_project_repeated_save_is_stable_and_stays_under_vault() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let document = serde_json::json!({
            "remote": {"url": "https://example.test/mcp", "enabled": true}
        });

        let first = service.mcp_project_set(document.clone(), true).unwrap();
        let first_raw = fs::read_to_string(&first.path).unwrap();
        let second = service.mcp_project_set(document, true).unwrap();
        let second_raw = fs::read_to_string(&second.path).unwrap();

        assert_eq!(first.path, second.path);
        assert_eq!(first.servers, second.servers);
        assert_eq!(first_raw, second_raw);
        assert!(Path::new(&second.path).starts_with(service.path()));
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
        let first = service
            .write("a.md", &note_raw("v1"), None, "test")
            .unwrap();
        service
            .write("a.md", &note_raw("v2"), Some(&first.sha256), "test")
            .unwrap();
        let history = directory.path().join(".lattice/history").join(NOTE_ID);
        let mut versions: Vec<String> = std::fs::read_dir(&history)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        versions.sort();
        assert_eq!(
            versions.len(),
            1,
            "只应有一次覆盖产生一个快照：{versions:?}"
        );
        let snapshotted = std::fs::read_to_string(history.join(&versions[0])).unwrap();
        assert!(snapshotted.contains("v1"), "快照应保存旧内容 v1");
        let version = versions[0].trim_end_matches(".md");
        let (stamp, _) = version.split_once('-').unwrap();
        assert_eq!(
            stamp.len(),
            19,
            "版本名应为 8 位日期 + T + 9 位时间 + Z：{stamp}"
        );
    }

    #[test]
    fn snapshot_skipped_when_latest_matches_previous_content() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let first = service
            .write("a.md", &note_raw("v1"), None, "test")
            .unwrap();
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
        let first = service
            .write("bare.md", "无 frontmatter", None, "test")
            .unwrap();
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
                store
                    .create(
                        super::frontmatter_id(&previous.raw).unwrap().as_str(),
                        &previous.raw,
                        limit,
                    )
                    .unwrap();
                expected_hash = Some(previous.sha256.clone());
            }
            service
                .write("a.md", &raw, expected_hash.as_deref(), "test")
                .unwrap();
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
        assert_eq!(
            paths,
            vec!["attachments/pic.png", "data.bin", "docs/paper.pdf"]
        );
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
            .write(
                "a.md",
                &note_raw("![used](attachments/used.png)"),
                None,
                "test",
            )
            .unwrap();

        let preview = service.attachment_cleanup(true, false, false).unwrap();
        assert!(preview.dry_run);
        let candidates: Vec<&str> = preview
            .candidates
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(
            candidates,
            vec!["attachments/note.txt", "attachments/orphan.png"]
        );

        let rejected = service.attachment_cleanup(false, true, false).unwrap_err();
        assert_eq!(rejected.code, "CONFIRMATION_REQUIRED");

        let outcome = service.attachment_cleanup(false, true, true).unwrap();
        assert!(!outcome.dry_run);
        assert_eq!(
            outcome.deleted,
            vec!["attachments/note.txt", "attachments/orphan.png"]
        );
        assert!(outcome.skipped.is_empty());
        assert!(!directory.path().join("attachments/orphan.png").exists());
        assert!(!directory.path().join("attachments/note.txt").exists());
        assert!(
            directory.path().join("attachments/used.png").exists(),
            "被引用附件必须保留"
        );
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
        let missing = service
            .vault_download("attachments/missing.png")
            .unwrap_err();
        assert_eq!(missing.code, "NOT_FOUND");
    }

    #[test]
    fn file_read_slices_by_characters_and_reports_eof() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        write_file(
            directory.path(),
            "docs/note.md",
            "你好世界，hello".as_bytes(),
        );

        let first = service.file_read("docs/note.md", 0, Some(5)).unwrap();
        assert_eq!(first.content, "你好世界，");
        assert!(!first.eof);
        assert_eq!(first.size, "你好世界，hello".len() as u64);

        let second = service.file_read("docs/note.md", 5, Some(50)).unwrap();
        assert_eq!(second.content, "hello");
        assert!(second.eof);

        let missing = service.file_read("docs/missing.md", 0, None).unwrap_err();
        assert_eq!(missing.code, "NOT_FOUND");
    }

    #[test]
    fn file_find_and_grep_cover_glob_type_and_regex() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        write_file(
            directory.path(),
            "docs/a.md",
            "第一行 TARGETS\n第二行\n".as_bytes(),
        );
        write_file(directory.path(), "docs/b.txt", "plain".as_bytes());
        write_file(directory.path(), "c.md", "root targets".as_bytes());

        let all_md = service
            .file_find(Some("**/*.md".into()), None, None)
            .unwrap();
        assert_eq!(all_md.total, 2);
        let typed = service
            .file_find(Some("**/*".into()), Some("docs".into()), Some("txt".into()))
            .unwrap();
        assert_eq!(typed.total, 1);
        assert_eq!(typed.items[0].path, "docs/b.txt");

        // 普通文本大小写不敏感
        let plain = service
            .file_grep("targets".into(), None, false, None)
            .unwrap();
        assert_eq!(plain.total, 2);
        let regexed = service
            .file_grep("^第二行$".into(), Some("docs".into()), true, None)
            .unwrap();
        assert_eq!(regexed.total, 1);
        assert_eq!(regexed.items[0].line, 2);
    }

    #[test]
    fn file_edit_roundtrip_previews_executes_and_undoes() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        write_file(directory.path(), "doc.md", "hello world\n".as_bytes());

        let action = FileAction {
            action_type: "edit".into(),
            path: "doc.md".into(),
            target_path: None,
            content: None,
            replace: Some("world".into()),
            with: Some("rust".into()),
            all: None,
        };
        let preview = service.file_preview(Some(action.clone()), None).unwrap();
        let plan_hash = preview["planHash"].as_str().unwrap().to_owned();
        assert_eq!(
            preview["requiresSecondConfirmation"],
            serde_json::json!(false)
        );
        assert!(preview["diff"].as_str().unwrap().contains("+hello rust"));
        assert_eq!(preview["confirmation"]["required"], serde_json::json!(true));

        let executed = service
            .file_execute(Some(action), None, true, false, None, Some(plan_hash))
            .unwrap();
        assert_eq!(executed["replaced"], serde_json::json!(1));
        assert_eq!(executed["undoable"], serde_json::json!(true));
        assert_eq!(
            fs::read_to_string(directory.path().join("doc.md")).unwrap(),
            "hello rust\n"
        );
        let operation_id = executed["operationId"].as_str().unwrap().to_owned();

        // planHash 与当前状态不符必须被拒
        let stale = FileAction {
            action_type: "edit".into(),
            path: "doc.md".into(),
            target_path: None,
            content: None,
            replace: Some("rust".into()),
            with: Some("world".into()),
            all: None,
        };
        let rejected = service
            .file_execute(Some(stale), None, true, false, None, Some("0".repeat(64)))
            .unwrap_err();
        assert_eq!(rejected.code, "CONFLICT");

        let undone = service
            .file_undo(Some(operation_id.clone()), false)
            .unwrap();
        assert_eq!(undone["undone"], serde_json::json!(true));
        assert_eq!(
            fs::read_to_string(directory.path().join("doc.md")).unwrap(),
            "hello world\n"
        );
        let again = service.file_undo(Some(operation_id), false).unwrap_err();
        assert_eq!(again.code, "CONFLICT");
    }

    #[test]
    fn batch_outcome_exposes_compensation_without_write_payloads() {
        let action = FileAction {
            action_type: "write".into(),
            path: "Notes/a.md".into(),
            target_path: None,
            content: Some("secret body must not be returned".into()),
            replace: None,
            with: None,
            all: None,
        };
        let outcome = fc_batch_outcome(
            "batch-1",
            &serde_json::json!("plan-1"),
            serde_json::json!(1),
            "hash-1",
            2,
            1,
            1,
            true,
            vec![serde_json::json!("operation-1")],
            vec![serde_json::json!({
                "id": "action-1",
                "status": "completed",
                "result": { "operationId": "operation-1" },
            })],
            serde_json::json!({}),
            Some("second action failed".into()),
        );
        assert_eq!(outcome["partialFailure"], serde_json::json!(true));
        assert_eq!(outcome["completed"], serde_json::json!(1));
        assert_eq!(outcome["failed"], serde_json::json!(1));
        assert_eq!(
            outcome["compensation"]["operationIds"][0],
            serde_json::json!("operation-1")
        );
        assert!(!outcome.to_string().contains("secret body"));
        assert!(!outcome.to_string().contains(&action.content.unwrap()));
    }

    #[test]
    fn file_delete_requires_second_confirmation_and_undo_restores() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        write_file(directory.path(), "gone.txt", b"delete me");

        let action = FileAction {
            action_type: "delete".into(),
            path: "gone.txt".into(),
            target_path: None,
            content: None,
            replace: None,
            with: None,
            all: None,
        };
        let preview = service.file_preview(Some(action.clone()), None).unwrap();
        assert_eq!(
            preview["confirmation"]["secondConfirmationRequired"],
            serde_json::json!(true)
        );
        let plan_hash = preview["planHash"].as_str().unwrap().to_owned();

        // 闸门顺序：confirmed → planHash → delete 的 secondConfirmed
        let no_confirmation = service
            .file_execute(
                Some(action.clone()),
                None,
                false,
                true,
                None,
                Some(plan_hash.clone()),
            )
            .unwrap_err();
        assert_eq!(no_confirmation.code, "VALIDATION");
        let no_plan = service
            .file_execute(Some(action.clone()), None, true, true, None, None)
            .unwrap_err();
        assert_eq!(no_plan.code, "VALIDATION");
        let no_second = service
            .file_execute(
                Some(action.clone()),
                None,
                true,
                false,
                None,
                Some(plan_hash.clone()),
            )
            .unwrap_err();
        assert_eq!(no_second.code, "VALIDATION");

        let executed = service
            .file_execute(Some(action), None, true, true, None, Some(plan_hash))
            .unwrap();
        assert!(!directory.path().join("gone.txt").exists());
        let undone = service
            .file_undo(
                Some(executed["operationId"].as_str().unwrap().to_owned()),
                false,
            )
            .unwrap();
        assert_eq!(undone["undone"], serde_json::json!(true));
        assert_eq!(
            fs::read_to_string(directory.path().join("gone.txt")).unwrap(),
            "delete me"
        );
    }

    #[test]
    fn ai_file_execution_rechecks_role_scope_and_idempotency() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        write_file(directory.path(), "allowed.md", b"before");
        write_file(directory.path(), "outside.md", b"outside");

        let action = FileAction {
            action_type: "write".into(),
            path: "allowed.md".into(),
            target_path: None,
            content: Some("after".into()),
            replace: None,
            with: None,
            all: None,
        };
        let preview = service.file_preview(Some(action.clone()), None).unwrap();
        let plan_hash = preview["planHash"].as_str().unwrap().to_owned();
        let denied_viewer = service
            .file_execute_with_context(
                Some(action.clone()),
                None,
                true,
                false,
                None,
                Some(plan_hash.clone()),
                "local-user",
                "viewer",
                Some(&["allowed.md".to_owned()]),
                Some("run-1:op-1"),
            )
            .unwrap_err();
        assert_eq!(denied_viewer.code, "VALIDATION");

        let denied_scope = service
            .file_execute_with_context(
                Some(FileAction { path: "outside.md".into(), ..action.clone() }),
                None,
                true,
                false,
                None,
                Some(plan_hash.clone()),
                "local-user",
                "editor",
                Some(&["allowed.md".to_owned()]),
                Some("run-1:op-2"),
            )
            .unwrap_err();
        assert_eq!(denied_scope.code, "VALIDATION");

        let first = service
            .file_execute_with_context(
                Some(action.clone()),
                None,
                true,
                false,
                None,
                Some(plan_hash.clone()),
                "local-user",
                "editor",
                Some(&["allowed.md".to_owned()]),
                Some("run-1:op-1"),
            )
            .unwrap();
        let second = service
            .file_execute_with_context(
                Some(action),
                None,
                true,
                false,
                None,
                Some(plan_hash),
                "local-user",
                "editor",
                Some(&["allowed.md".to_owned()]),
                Some("run-1:op-1"),
            )
            .unwrap();
        assert_eq!(first["operationId"], second["operationId"]);
        assert_eq!(fs::read_to_string(directory.path().join("allowed.md")).unwrap(), "after");
    }

    #[test]
    fn file_log_lists_recent_audit_entries_newest_first() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        assert!(service.file_log(None).unwrap().is_empty());

        write_file(directory.path(), "a.txt", b"1");
        let action = FileAction {
            action_type: "write".into(),
            path: "a.txt".into(),
            target_path: None,
            content: Some("2".into()),
            replace: None,
            with: None,
            all: None,
        };
        let preview = service.file_preview(Some(action.clone()), None).unwrap();
        let plan_hash = preview["planHash"].as_str().unwrap().to_owned();
        service
            .file_execute(Some(action), None, true, false, None, Some(plan_hash))
            .unwrap();

        let log = service.file_log(None).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0]["type"], serde_json::json!("write"));
        assert_eq!(log[0]["status"], serde_json::json!("completed"));
        assert_eq!(log[0]["source"], serde_json::json!("files-api"));
    }

    #[test]
    fn expert_list_contains_builtin_and_supports_workspace_override() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let listed = service.expert_list().unwrap();
        assert_eq!(
            BUILTIN_EXPERTS.len(),
            7,
            "builtin experts 资源数量必须与迁移基线一致"
        );
        assert_eq!(
            BUILTIN_SKILLS.len(),
            9,
            "builtin skills 资源数量必须与迁移基线一致"
        );
        assert!(
            BUILTIN_EXPERTS
                .iter()
                .all(|raw| serde_json::from_str::<serde_json::Value>(raw).is_ok())
        );
        assert!(
            BUILTIN_SKILLS
                .iter()
                .all(|(manifest, body)| !manifest.is_empty() && !body.is_empty())
        );
        assert!(
            listed
                .iter()
                .any(|expert| expert["id"] == serde_json::json!("general")
                    && expert["source"] == serde_json::json!("builtin"))
        );
        let builtin_count = listed.len();

        // 更新内置专家：写入工作区版本（读取时覆盖视图，builtin 原件不动）
        let updated = service
            .expert_save(
                serde_json::json!({ "name": "通用助手", "description": "工作区覆盖版" }),
                Some("general".into()),
                true,
            )
            .unwrap();
        assert_eq!(updated["source"], serde_json::json!("workspace"));
        assert_eq!(updated["description"], serde_json::json!("工作区覆盖版"));
        let listed = service.expert_list().unwrap();
        assert_eq!(listed.len(), builtin_count, "同 id 覆盖不新增条目");
        let general = listed
            .iter()
            .find(|expert| expert["id"] == serde_json::json!("general"))
            .unwrap();
        assert_eq!(general["source"], serde_json::json!("workspace"));
    }

    #[test]
    fn expert_save_and_skill_save_enforce_confirmation_and_builtin_protection() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());

        let rejected = service
            .expert_save(
                serde_json::json!({ "name": "x" }),
                Some("my-expert".into()),
                false,
            )
            .unwrap_err();
        assert_eq!(rejected.code, "CONFIRMATION_REQUIRED");
        let bad_id = service
            .expert_save(
                serde_json::json!({ "name": "x" }),
                Some("Bad_ID".into()),
                true,
            )
            .unwrap_err();
        assert_eq!(bad_id.code, "VALIDATION");
        let builtin_conflict = service
            .expert_save(
                serde_json::json!({ "id": "general", "name": "自定义 general" }),
                None,
                true,
            )
            .unwrap_err();
        assert_eq!(builtin_conflict.code, "CONFLICT");

        let created = service
            .expert_save(serde_json::json!({ "id": "my-expert", "name": "我的专家", "skills": ["vault-search"] }), None, true)
            .unwrap();
        assert_eq!(created["source"], serde_json::json!("workspace"));
        assert_eq!(
            created["skills"][0]["id"],
            serde_json::json!("vault-search")
        );
        assert!(
            created["skills"][0]["skill"].is_object(),
            "详情应嵌入技能定义摘要"
        );
        // available 只在列表口径出现（对齐 listExperts）
        let listed = service.expert_list().unwrap();
        let mine = listed
            .iter()
            .find(|expert| expert["id"] == serde_json::json!("my-expert"))
            .unwrap();
        assert_eq!(mine["skills"][0]["available"], serde_json::json!(true));

        let skill_conflict = service
            .skill_save(
                serde_json::json!({ "id": "vault-search", "name": "x", "content": "覆盖内置" }),
                None,
                true,
            )
            .unwrap_err();
        assert_eq!(skill_conflict.code, "CONFLICT");

        let empty = service
            .skill_save(
                serde_json::json!({ "id": "my-skill", "name": "x", "content": "  " }),
                None,
                true,
            )
            .unwrap_err();
        assert_eq!(empty.code, "VALIDATION");

        let skill = service
            .skill_save(
                serde_json::json!({ "id": "my-skill", "name": "我的技能", "content": "技能正文" }),
                None,
                true,
            )
            .unwrap();
        // SKILL.md 落盘带尾换行（对齐 Express `${content}\n`），读回即含 \n
        assert_eq!(skill["content"], serde_json::json!("技能正文\n"));
        let detail = service.skill_get("my-skill").unwrap();
        assert_eq!(detail["contentHash"], skill["contentHash"]);
        assert!(
            directory
                .path()
                .join(".lattice/skills/my-skill/SKILL.md")
                .exists()
        );
    }

    #[test]
    fn expert_route_ranks_keyword_matches_and_excludes_general() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let message = "帮我整理收件箱并归档决策";
        let suggestions = service.expert_route(message, None).unwrap();
        // general 永不参与；命中关键词的专家按 score 排序
        assert!(
            suggestions
                .iter()
                .all(|item| item["id"] != serde_json::json!("general"))
        );
        let excluded = service
            .expert_route(
                message,
                suggestions
                    .first()
                    .and_then(|item| item["id"].as_str())
                    .map(str::to_owned),
            )
            .unwrap();
        assert!(
            excluded
                .iter()
                .all(|item| Some(item["id"].as_str().unwrap_or_default())
                    != suggestions.first().and_then(|item| item["id"].as_str()))
        );
        assert!(suggestions.len() <= 3);
    }

    #[test]
    fn expert_delete_and_skill_delete_only_remove_workspace_versions() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        service
            .expert_save(
                serde_json::json!({ "id": "temp-expert", "name": "临时" }),
                None,
                true,
            )
            .unwrap();
        service
            .skill_save(
                serde_json::json!({ "id": "temp-skill", "name": "临时", "content": "正文" }),
                None,
                true,
            )
            .unwrap();

        let no_second = service
            .expert_delete("temp-expert", true, false)
            .unwrap_err();
        assert_eq!(no_second.code, "CONFIRMATION_REQUIRED");
        let deleted = service.expert_delete("temp-expert", true, true).unwrap();
        assert_eq!(deleted["deleted"], serde_json::json!(true));
        assert!(
            !directory
                .path()
                .join(".lattice/experts/temp-expert.json")
                .exists()
        );
        assert!(
            service
                .expert_list()
                .unwrap()
                .iter()
                .any(|expert| expert["id"] == serde_json::json!("general"))
        );

        let skill_deleted = service.skill_delete("temp-skill", true, true).unwrap();
        assert_eq!(skill_deleted["deleted"], serde_json::json!(true));
        let missing = service.skill_delete("temp-skill", true, true).unwrap_err();
        assert_eq!(missing.code, "NOT_FOUND");
        // 内置技能不受影响
        assert!(service.skill_get("vault-search").is_ok());
    }

    #[test]
    fn review_health_scan_reports_findings_and_score() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        // Inbox 未处理 → error 级；无链接无标签 → candidate 级
        service
            .write(
                "inbox/待处理.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234568\ntitle: 待处理\ntype: inbox\nstatus: captured\n---\n\n正文\n",
                None,
                "test",
            )
            .unwrap();
        let report = service.review_health(90, 100).unwrap();
        assert_eq!(report["noteCount"], serde_json::json!(1));
        assert_eq!(
            report["summary"]["hardTotal"],
            serde_json::json!(1),
            "Inbox 未处理应为 error"
        );
        assert!(report["summary"]["healthScore"].as_i64().unwrap() < 100);
        let isolated = report["categories"]["isolated"].as_array().unwrap();
        assert_eq!(isolated.len(), 1);
        // 未知 finding id 生成计划必须被拒
        let rejected = service
            .review_plan(vec!["not-exist".into()], 90, 100)
            .unwrap_err();
        assert_eq!(rejected.code, "VALIDATION");
    }

    #[test]
    fn review_plan_executes_metadata_repair_with_hash_guard() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        service
            .write(
                "notes/a.md",
                "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234569\ntitle: 缺来源\ncreated_at: 2026-10-13T00:00:00.000Z\nupdated_at: 2026-10-13T00:00:00.000Z\n---\n\n[[目标]]\n",
                None,
                "test",
            )
            .unwrap();
        let report = service.review_health(90, 100).unwrap();
        let metadata = report["categories"]["metadata"].as_array().unwrap();
        assert!(!metadata.is_empty(), "缺来源/标签应有 metadata 线索");
        let finding_ids: Vec<String> = metadata
            .iter()
            .filter_map(|item| item["id"].as_str().map(str::to_owned))
            .collect();
        let plan = service.review_plan(finding_ids, 90, 100).unwrap();
        let plan_hash = plan["planHash"].as_str().unwrap().to_owned();
        assert_eq!(plan["confirmation"]["required"], serde_json::json!(true));

        // planHash 不符必须被拒
        let mismatch = service
            .review_execute(
                plan["id"].as_str().unwrap(),
                "0".repeat(64).as_str(),
                true,
                true,
            )
            .unwrap_err();
        assert_eq!(mismatch.code, "CONFLICT");
        // 未确认必须被拒
        let unconfirmed = service
            .review_execute(plan["id"].as_str().unwrap(), &plan_hash, false, true)
            .unwrap_err();
        assert_eq!(unconfirmed.code, "CONFIRMATION_REQUIRED");

        let executed = service
            .review_execute(plan["id"].as_str().unwrap(), &plan_hash, true, true)
            .unwrap();
        assert_eq!(
            executed["completed"],
            serde_json::json!(1),
            "缺来源应自动补全 source"
        );
        let detail = service
            .index
            .find_note_detail(Some("019501a2-3b4c-4c5d-89ab-cdef01234569"), None)
            .unwrap()
            .unwrap();
        assert!(
            detail
                .properties_json
                .unwrap_or_default()
                .contains("vault:notes/a.md")
        );
        // 计划执行后即删除
        let again = service
            .review_execute(plan["id"].as_str().unwrap(), &plan_hash, true, true)
            .unwrap_err();
        assert_eq!(again.code, "CONFLICT");
    }

    /// 目录树必须真正成层，且兄弟按 name 的 ASCII 不敏感升序（对齐 Express
    /// `ORDER BY sort_order ASC, name COLLATE NOCASE ASC`）。
    ///
    /// 这两点 parity harness 都量不到：前者曾因「先 `nodes.remove` 再在剩余节点里找父」
    /// 被整棵拍平成多个根节点，而 fixture 的目录树只有一个根、一个子，且数组只采样首元素，
    /// 连顺序都看不出来。
    #[test]
    fn folder_tree_nests_and_orders_siblings_like_express() {
        let directory = tempfile::tempdir().unwrap();
        for path in ["alpha", "Beta", "Beta/child", "attachments"] {
            fs::create_dir_all(directory.path().join(path)).unwrap();
        }
        fs::write(directory.path().join("alpha/note.md"), note_raw("内容")).unwrap();
        let service = open_service(directory.path());
        service.index().scan(service.vault()).unwrap();

        let roots = service.index().folder_tree(service.vault()).unwrap();
        let names: Vec<&str> = roots.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["alpha", "Beta"],
            "NOCASE 升序：alpha 必须排在 Beta 之前"
        );
        assert_eq!(roots[0].note_count, 1, "noteCount 是**直属**笔记数");
        assert_eq!(roots[0].children.len(), 0);
        assert_eq!(
            roots[1].children.len(),
            1,
            "子目录必须挂在父节点下，不能另起为根"
        );
        assert_eq!(roots[1].children[0].name, "child");
        assert_eq!(
            roots[1].children[0].parent_id.as_deref(),
            Some(roots[1].id.as_str()),
            "子节点的 parentId 必须指向父节点 id"
        );
        assert!(
            roots[0].created_at.ends_with('Z'),
            "createdAt 是 ISO-8601 UTC"
        );
        assert!(
            roots[0].updated_at.ends_with('Z'),
            "updatedAt 是 ISO-8601 UTC"
        );
    }

    #[test]
    fn folder_delete_moves_non_empty_contents_to_vault_root() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let folder = service.folder_create("待删除", None, None, true).unwrap();
        write_file(
            directory.path(),
            "待删除/源笔记.md",
            note_raw("正文").as_bytes(),
        );
        write_file(directory.path(), "待删除/附件.pdf", b"pdf");
        write_file(directory.path(), "待删除/子目录/附件.pdf", b"nested");
        write_file(directory.path(), "测试.md", b"existing");
        service.index().scan(service.vault()).unwrap();

        let result = service.folder_delete(&folder.id, true, true).unwrap();

        assert_eq!(result["deletedFolderCount"], serde_json::json!(1));
        assert_eq!(result["affectedNoteCount"], serde_json::json!(1));
        assert!(!directory.path().join("待删除").exists());
        assert_eq!(
            fs::read_to_string(directory.path().join("测试 (2).md")).unwrap(),
            note_raw("正文")
        );
        let mut attachment_contents = vec![
            fs::read(directory.path().join("附件.pdf")).unwrap(),
            fs::read(directory.path().join("附件 (2).pdf")).unwrap(),
        ];
        attachment_contents.sort();
        assert_eq!(
            attachment_contents,
            vec![b"nested".to_vec(), b"pdf".to_vec()]
        );
    }

    #[test]
    fn notes_create_and_update_honor_folder_id_three_state_semantics() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let folder = service.folder_create("目标目录", None, None, true).unwrap();
        let note_id = "019501a2-3b4c-4c5d-89ab-cdef01234570".to_owned();

        let created = service
            .create_note(
                Some(note_id.clone()),
                Some("目录笔记".into()),
                "正文",
                Some(folder.id.clone()),
                &serde_json::Map::new(),
                true,
            )
            .unwrap();
        assert_eq!(created.folder_id.as_deref(), Some(folder.id.as_str()));
        assert_eq!(created.file_path.as_deref(), Some("目标目录/目录笔记.md"));
        assert!(directory.path().join("目标目录/目录笔记.md").exists());

        let rejected = service
            .update_note(&note_id, None, None, Some(None), None, None, None, false)
            .unwrap_err();
        assert_eq!(rejected.code, "CONFIRMATION_REQUIRED");

        let moved = service
            .update_note(&note_id, None, None, Some(None), None, None, None, true)
            .unwrap();
        assert_eq!(moved.folder_id, None);
        assert_eq!(moved.file_path.as_deref(), Some("目录笔记.md"));
        assert!(!directory.path().join("目标目录/目录笔记.md").exists());
        assert!(directory.path().join("目录笔记.md").exists());

        let kept = service
            .update_note(
                &note_id,
                None,
                Some("只改正文".into()),
                None,
                None,
                None,
                None,
                true,
            )
            .unwrap();
        assert_eq!(kept.folder_id, None, "省略 folderId 必须保持原目录");
    }

    #[test]
    fn templates_duplicate_and_daily_creation_validate_inputs_and_are_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let templates = service.list_templates().unwrap();
        assert_eq!(templates.len(), 6);
        assert!(templates.iter().any(|template| template["name"] == "daily"));

        let invalid_date = service
            .create_from_template(
                "meeting",
                Some("会议".into()),
                Some("2026-99-99".into()),
                None,
                true,
            )
            .unwrap_err();
        assert_eq!(invalid_date.code, "VALIDATION");

        let original = service
            .create_note(
                Some("019501a2-3b4c-4c5d-89ab-cdef01234574".into()),
                Some("原始笔记".into()),
                "原始正文",
                None,
                &serde_json::Map::new(),
                true,
            )
            .unwrap();
        let duplicate = service.duplicate_note(&original.id, None, true).unwrap();
        assert_ne!(duplicate.id, original.id);
        assert_eq!(duplicate.title, "原始笔记（副本）");
        assert!(duplicate.content.ends_with("原始正文"));
        assert!(!duplicate.content.contains(&original.id));

        let daily = service
            .create_daily_note(Some("2026-02-28".into()), true)
            .unwrap();
        let daily_again = service
            .create_daily_note(Some("2026-02-28".into()), true)
            .unwrap();
        assert_eq!(daily.id, daily_again.id, "每日笔记按日期必须幂等");
        assert!(
            daily
                .file_path
                .as_deref()
                .is_some_and(|path| path == "Daily/2026-02-28.md")
        );

        let invalid_daily = service
            .create_daily_note(Some("2026-02-29".into()), true)
            .unwrap_err();
        assert_eq!(invalid_daily.code, "VALIDATION");
    }

    #[test]
    fn ai_digest_is_local_idempotent_and_requires_confirmation() {
        let directory = tempfile::tempdir().unwrap();
        let service = open_service(directory.path());
        let rejected = service.generate_ai_digest(None, false).unwrap_err();
        assert_eq!(rejected.code, "CONFIRMATION_REQUIRED");

        let source = service
            .create_note(
                Some("019501a2-3b4c-4c5d-89ab-cdef01234575".into()),
                Some("今天的工作".into()),
                "本地摘要来源",
                None,
                &serde_json::Map::new(),
                true,
            )
            .unwrap();
        let today = source
            .updated_at
            .as_deref()
            .unwrap_or_default()
            .get(..10)
            .unwrap()
            .to_owned();
        let first = service.generate_ai_digest(Some(today.clone()), true).unwrap();
        let second = service.generate_ai_digest(Some(today), true).unwrap();
        assert_eq!(first["created"], true);
        assert_eq!(second["created"], false);
        assert_eq!(first["noteId"], second["noteId"]);
        assert_eq!(first["modifiedCount"], 1);
    }

    /// 附件仓库不算笔记目录（Express 的 `folders` 表里没有它），但**只在下辖没有笔记时**才隐藏：
    /// 用户自建同名目录并放入笔记时，Express 会建行并显示，Rust 不能把它吞掉。
    #[test]
    fn attachment_store_is_a_folder_only_when_it_holds_notes() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("attachments")).unwrap();
        let service = open_service(directory.path());
        service.index().scan(service.vault()).unwrap();

        assert!(
            service
                .index()
                .folder_tree(service.vault())
                .unwrap()
                .is_empty(),
            "空的附件仓库不应出现在笔记目录树里"
        );
        assert_eq!(
            service
                .index()
                .meta_overview(service.vault())
                .unwrap()
                .folder_count,
            0,
            "目录计数同样不含附件仓库（对齐 Express COUNT(*) FROM folders）"
        );

        fs::write(
            directory.path().join("attachments/note.md"),
            note_raw("放在附件仓库里的笔记"),
        )
        .unwrap();
        service.index().scan(service.vault()).unwrap();
        let roots = service.index().folder_tree(service.vault()).unwrap();
        assert_eq!(roots.len(), 1, "里面有笔记时应按用户的笔记目录保留");
        assert_eq!(roots[0].name, "attachments");
        assert_eq!(
            service
                .index()
                .meta_overview(service.vault())
                .unwrap()
                .folder_count,
            1
        );
    }
}
