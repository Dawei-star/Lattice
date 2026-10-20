use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tempfile::NamedTempFile;
use walkdir::{DirEntry, WalkDir};

use crate::time::iso8601_utc;

const MAX_NOTE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 10 * 1024 * 1024;
const INTERNAL_DIRS: [&str; 3] = [".lattice", ".fc", "_templates"];

/// Vault 文件系统封装：只负责安全地读写磁盘上的 Markdown，
/// 不感知索引与命令层（状态由 `WorkspaceState` 承载）。
pub struct Vault {
    root: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub(crate) vault_dir: String,
    pub(crate) mode: String,
    pub(crate) profile: serde_json::Value,
    pub(crate) profile_path: String,
    pub(crate) profile_status: String,
    pub(crate) profile_warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultAssetEntry {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) mime_type: String,
    pub(crate) size: u64,
    pub(crate) modified_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub(crate) path: String,
    pub(crate) title: String,
    pub(crate) bytes: u64,
    pub(crate) modified_at: Option<i64>,
}

/// 文件元数据：只 stat 不读盘，供增量索引比对使用。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileMeta {
    pub(crate) path: String,
    pub(crate) bytes: u64,
    pub(crate) modified_at: Option<i64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteContents {
    pub(crate) path: String,
    pub(crate) raw: String,
    pub(crate) sha256: String,
}

impl Vault {
    pub fn open(root: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        Ok(Self {
            root: root.canonicalize()?,
        })
    }

    fn note_path(&self, relative: &str, create_parent: bool) -> Result<PathBuf, String> {
        let path = Path::new(relative);
        if relative.is_empty() || !relative.to_ascii_lowercase().ends_with(".md") {
            return Err("Only Markdown notes inside the Vault are supported".into());
        }
        let components: Vec<_> = path.components().collect();
        for component in &components {
            let Component::Normal(part) = component else {
                return Err("Invalid Vault-relative path".into());
            };
            let name = part.to_string_lossy();
            if name.contains(':')
                || name.ends_with([' ', '.'])
                || INTERNAL_DIRS
                    .iter()
                    .any(|reserved| name.eq_ignore_ascii_case(reserved))
            {
                return Err("Reserved or invalid Vault path".into());
            }
        }
        let mut candidate = self.root.clone();
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(part) = component else {
                unreachable!()
            };
            candidate.push(part);
            if index + 1 < components.len() {
                if !candidate.exists() && create_parent {
                    fs::create_dir(&candidate).map_err(|error| error.to_string())?;
                }
                let real_directory = candidate
                    .canonicalize()
                    .map_err(|error| error.to_string())?;
                if !real_directory.starts_with(&self.root) || !real_directory.is_dir() {
                    return Err("Vault path escapes its root".into());
                }
            }
        }
        if candidate.exists() {
            let real_file = candidate
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !real_file.starts_with(&self.root) || !real_file.is_file() {
                return Err("Vault path is not a regular note".into());
            }
        }
        Ok(candidate)
    }

    // 列表/检索的正常路径走 index 投影；本方法供 P1-04 命令面迁移接线。
    #[allow(dead_code)]
    pub fn list(&self) -> Result<Vec<NoteFile>, String> {
        let mut notes = Vec::new();
        for file in self.walk_note_files()? {
            let title = frontmatter_title(&self.root.join(&file.path))
                .unwrap_or_else(|| file_stem(&file.path));
            notes.push(NoteFile {
                path: file.path,
                title,
                bytes: file.bytes,
                modified_at: file.modified_at,
            });
        }
        Ok(notes)
    }

    /// 只 stat 不读盘的文件清单，供增量索引比对（未变化的文件因此完全不需要读盘）。
    pub(crate) fn scan_files(&self) -> Result<Vec<FileMeta>, String> {
        self.walk_note_files()
    }

    /// 单篇笔记的文件元数据，用于写入后零延迟刷新索引。
    pub(crate) fn stat(&self, relative: &str) -> Result<FileMeta, String> {
        let path = self.note_path(relative, false)?;
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        Ok(FileMeta {
            path: relative.replace('\\', "/"),
            bytes: metadata.len(),
            modified_at: modified_millis(&metadata),
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// 返回与 Express `/vault/info` 相同形状的 Vault 元数据。
    pub fn info(&self) -> VaultInfo {
        let profile_path = self.profile_path();
        let (profile, profile_status, profile_warning) = match fs::read_to_string(&profile_path) {
            Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw)
                .map_err(|error| error.to_string())
                .and_then(|value| normalize_profile(&value))
            {
                Ok(profile) => (profile, "loaded".to_owned(), None),
                Err(error) => (
                    default_profile(),
                    "invalid".to_owned(),
                    Some(format!("Invalid Vault profile: {error}")),
                ),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (default_profile(), "default".to_owned(), None)
            }
            Err(error) => (
                default_profile(),
                "invalid".to_owned(),
                Some(format!("Unable to read Vault profile: {error}")),
            ),
        };

        VaultInfo {
            vault_dir: self.root.to_string_lossy().into_owned(),
            mode: "markdown".to_owned(),
            profile,
            profile_path: profile_path.to_string_lossy().into_owned(),
            profile_status,
            profile_warning,
        }
    }

    pub fn save_profile(&self, profile: serde_json::Value) -> Result<VaultInfo, String> {
        let normalized = normalize_profile(&profile)?;
        let directory = self.root.join(".lattice");
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let mut temporary = NamedTempFile::new_in(&directory).map_err(|error| error.to_string())?;
        let raw = serde_json::to_string_pretty(&normalized).map_err(|error| error.to_string())?;
        temporary
            .write_all(format!("{raw}\n").as_bytes())
            .map_err(|error| error.to_string())?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;

        let target = self.profile_path();
        if let Err(error) = fs::rename(temporary.path(), &target) {
            if !target.exists() {
                return Err(error.to_string());
            }
            fs::remove_file(&target).map_err(|remove_error| remove_error.to_string())?;
            fs::rename(temporary.path(), &target).map_err(|rename_error| rename_error.to_string())?;
        }
        Ok(self.info())
    }

    pub fn ensure_directory(&self, relative: &str) -> Result<(), String> {
        let normalized = normalize_folder_path(relative)?;
        fs::create_dir_all(self.root.join(normalized)).map_err(|error| error.to_string())
    }

    pub fn list_assets(&self) -> Result<Vec<VaultAssetEntry>, String> {
        let walker = WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| !excluded(entry));
        let mut assets = Vec::new();
        for entry in walker {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|error| error.to_string())?;
            if relative
                .components()
                .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
            {
                continue;
            }
            let Some(mime_type) = asset_mime(entry.path()) else {
                continue;
            };
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            assets.push(VaultAssetEntry {
                path: relative.to_string_lossy().replace('\\', "/"),
                name: entry.file_name().to_string_lossy().into_owned(),
                mime_type: mime_type.to_owned(),
                size: metadata.len(),
                modified_at: modified_millis(&metadata).map(iso8601_utc),
            });
        }
        assets.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(assets)
    }

    fn profile_path(&self) -> PathBuf {
        self.root.join(".lattice").join("profile.json")
    }

    /// 遍历 Vault 内的目录（跳过符号链接与内部目录），返回相对路径（/ 分隔）。
    /// folder_tree 投影用：目录结构以磁盘为准（含空目录）。
    pub(crate) fn walk_directories(&self) -> Result<Vec<String>, String> {
        let walker = WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| !excluded(entry));
        let mut directories = Vec::new();
        for entry in walker {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.depth() == 0 || !entry.file_type().is_dir() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|error| error.to_string())?;
            directories.push(relative.to_string_lossy().replace('\\', "/"));
        }
        directories.sort();
        Ok(directories)
    }

    /// 遍历 Vault 内的 Markdown 笔记（跳过符号链接与内部目录），返回按路径排序的元数据。
    fn walk_note_files(&self) -> Result<Vec<FileMeta>, String> {
        let mut files = Vec::new();
        let walker = WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| !excluded(entry));
        for entry in walker {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.file_type().is_file()
                || !entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(".md")
            {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|error| error.to_string())?;
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            files.push(FileMeta {
                path: relative.to_string_lossy().replace('\\', "/"),
                bytes: metadata.len(),
                modified_at: modified_millis(&metadata),
            });
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(files)
    }

    pub fn read(&self, relative: &str) -> Result<NoteContents, String> {
        let path = self.note_path(relative, false)?;
        let file = File::open(path).map_err(|error| error.to_string())?;
        if file.metadata().map_err(|error| error.to_string())?.len() > MAX_NOTE_BYTES {
            return Err("Note exceeds the 8 MB read limit".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_NOTE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_NOTE_BYTES {
            return Err("Note exceeds the 8 MB read limit".into());
        }
        let raw = String::from_utf8(bytes).map_err(|_| "Note is not valid UTF-8")?;
        Ok(NoteContents {
            path: relative.into(),
            sha256: checksum(raw.as_bytes()),
            raw,
        })
    }

    pub fn write(
        &self,
        relative: &str,
        raw: &str,
        expected_hash: Option<&str>,
    ) -> Result<NoteContents, String> {
        if raw.len() as u64 > MAX_NOTE_BYTES {
            return Err("Note exceeds the 8 MB write limit".into());
        }
        let path = self.note_path(relative, true)?;
        if path.exists() {
            let current = self.read(relative)?;
            if expected_hash != Some(current.sha256.as_str()) {
                return Err("Note changed on disk; reload before saving".into());
            }
        } else if expected_hash.is_some() {
            return Err("Note was removed before saving".into());
        }
        let parent = path.parent().ok_or("Invalid note path")?;
        let mut temporary = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        temporary
            .write_all(raw.as_bytes())
            .map_err(|error| error.to_string())?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        temporary
            .persist(&path)
            .map_err(|error| error.to_string())?;
        Ok(NoteContents {
            path: relative.into(),
            sha256: checksum(raw.as_bytes()),
            raw: raw.into(),
        })
    }

    #[allow(dead_code)] // P1-04 命令面迁移接线前暂未使用
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<NoteFile>, String> {
        let query = query.trim().to_lowercase();
        if query.is_empty() || query.chars().count() > 200 {
            return Err("Search query must contain 1-200 characters".into());
        }
        let mut matches = Vec::new();
        for note in self.list()? {
            if note.path.to_lowercase().contains(&query)
                || (note.bytes <= MAX_NOTE_BYTES
                    && self.read(&note.path)?.raw.to_lowercase().contains(&query))
            {
                matches.push(note);
                if matches.len() >= limit.clamp(1, 100) {
                    break;
                }
            }
        }
        Ok(matches)
    }

    pub fn read_asset(&self, relative: &str) -> Result<String, String> {
        let path = Path::new(relative);
        let mut parts = path.components();
        let Some(Component::Normal(first)) = parts.next() else {
            return Err("Invalid attachment path".into());
        };
        if !first.to_string_lossy().eq_ignore_ascii_case("attachments") {
            return Err("Only Vault attachments can be loaded".into());
        }
        for part in parts {
            let Component::Normal(name) = part else {
                return Err("Invalid attachment path".into());
            };
            if name.to_string_lossy().contains(':') {
                return Err("Invalid attachment path".into());
            }
        }
        let mime = match path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => return Err("Unsupported attachment format".into()),
        };
        let real = self
            .root
            .join(path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !real.starts_with(&self.root) || !real.is_file() {
            return Err("Attachment path escapes its Vault".into());
        }
        let file = File::open(real).map_err(|error| error.to_string())?;
        if file.metadata().map_err(|error| error.to_string())?.len() > MAX_ASSET_BYTES {
            return Err("Attachment exceeds the 10 MB read limit".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_ASSET_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err("Attachment exceeds the 10 MB read limit".into());
        }
        Ok(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }
}

pub(crate) fn excluded(entry: &DirEntry) -> bool {
    entry.file_type().is_symlink()
        || (entry.depth() > 0
            && entry.file_type().is_dir()
            && INTERNAL_DIRS.iter().any(|reserved| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(reserved)
            }))
}

/// 从 Markdown 原文推断标题：frontmatter `title` → 首个一级标题 → 文件名。
///
/// 磁盘文件不改写、不补 frontmatter，标题只是投影出来的展示值。
pub(crate) fn title_from_markdown(raw: &str, fallback_path: &str) -> String {
    frontmatter_title_of(raw)
        .or_else(|| first_heading(raw))
        .unwrap_or_else(|| file_stem(fallback_path))
}

/// frontmatter `title` 字段；不读正文、不改写文件。
pub(crate) fn frontmatter_title_of(raw: &str) -> Option<String> {
    let mut lines = raw.lines();
    if lines.next()?.trim_end_matches('\r') != "---" {
        return None;
    }
    let mut title = None;
    for line in lines.take(100) {
        let line = line.trim_end_matches('\r');
        if line == "---" {
            return title;
        }
        if let Some(value) = line.strip_prefix("title:") {
            let value = value.trim();
            if !value.is_empty() {
                title = Some(value.to_owned());
            }
        }
    }
    None
}

/// frontmatter 之后的第一个 `# 一级标题`。
fn first_heading(raw: &str) -> Option<String> {
    let body = match raw.starts_with("---") {
        true => raw
            .find("\n---")
            .map(|end| &raw[end + 4..])
            .unwrap_or(raw),
        false => raw,
    };
    body.lines()
        .map(|line| line.trim_end_matches('\r').trim())
        .find_map(|line| line.strip_prefix("# "))
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn modified_millis(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
}

#[allow(dead_code)] // 仅被同样暂未接线的 `list` 调用（P1-04）
fn frontmatter_title(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(16 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    frontmatter_title_of(&String::from_utf8_lossy(&bytes))
}

fn checksum(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn default_profile() -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "paths": {
            "inbox": "Inbox",
            "daily": "Daily",
            "journal": "Journal"
        }
    })
}

fn normalize_profile(value: &serde_json::Value) -> Result<serde_json::Value, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Vault profile must be an object".to_owned())?;
    if object.keys().any(|key| key != "version" && key != "paths") {
        return Err("Vault profile contains unknown fields".into());
    }
    if let Some(version) = object.get("version") {
        if version.as_u64() != Some(1) {
            return Err("Vault profile version must be 1".into());
        }
    }
    let paths = object
        .get("paths")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "Vault profile paths must be an object".to_owned())?;
    if paths.keys().any(|key| !matches!(key.as_str(), "inbox" | "daily" | "journal")) {
        return Err("Vault profile paths contains unknown fields".into());
    }
    let inbox = normalize_folder_path(
        paths
            .get("inbox")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Vault profile paths.inbox is required".to_owned())?,
    )?;
    let daily = normalize_folder_path(
        paths
            .get("daily")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Vault profile paths.daily is required".to_owned())?,
    )?;
    let journal = normalize_folder_path(
        paths
            .get("journal")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Vault profile paths.journal is required".to_owned())?,
    )?;
    Ok(serde_json::json!({
        "version": 1,
        "paths": { "inbox": inbox, "daily": daily, "journal": journal }
    }))
}

fn normalize_folder_path(value: &str) -> Result<String, String> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() || normalized.len() > 240 || normalized.starts_with('/') {
        return Err("Vault folder path must be a non-empty relative path".into());
    }
    for part in normalized.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.starts_with('.')
            || part.eq_ignore_ascii_case("_templates")
            || part.ends_with([' ', '.'])
            || part.chars().any(|character| "<>:\"|?*".contains(character))
        {
            return Err("Vault folder path contains an invalid or internal directory".into());
        }
    }
    Ok(normalized)
}

fn asset_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "avif" => Some("image/avif"),
        "gif" => Some("image/gif"),
        "jpeg" | "jpg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::Vault;

    #[test]
    fn write_requires_current_hash_and_keeps_existing_bytes_on_conflict() {
        let directory = tempfile::tempdir().unwrap();
        let vault = Vault::open(directory.path().into()).unwrap();
        let first = vault.write("notes/first.md", "first", None).unwrap();
        assert!(vault.write("notes/first.md", "second", None).is_err());
        assert!(
            vault
                .write("notes/first.md", "second", Some("wrong"))
                .is_err()
        );
        assert_eq!(vault.read("notes/first.md").unwrap().raw, "first");
        vault
            .write("notes/first.md", "second", Some(&first.sha256))
            .unwrap();
        assert_eq!(vault.read("notes/first.md").unwrap().raw, "second");
    }

    #[test]
    fn excludes_internal_paths_and_rejects_traversal() {
        let directory = tempfile::tempdir().unwrap();
        let vault = Vault::open(directory.path().into()).unwrap();
        std::fs::create_dir(directory.path().join(".lattice")).unwrap();
        std::fs::write(directory.path().join(".lattice/private.md"), "secret").unwrap();
        vault.write("visible.md", "hello", None).unwrap();
        assert_eq!(vault.list().unwrap().len(), 1);
        assert_eq!(vault.search("hello", 10).unwrap().len(), 1);
        assert!(vault.read(".lattice/private.md").is_err());
        assert!(vault.read("../outside.md").is_err());
        assert!(vault.write("new/../outside.md", "bad", None).is_err());
        assert!(!directory.path().join("new").exists());
    }

    #[test]
    fn attachments_are_limited_to_safe_image_files() {
        let directory = tempfile::tempdir().unwrap();
        let vault = Vault::open(directory.path().into()).unwrap();
        std::fs::create_dir(directory.path().join("attachments")).unwrap();
        std::fs::write(directory.path().join("attachments/test.png"), b"png").unwrap();
        std::fs::write(directory.path().join("attachments/test.svg"), b"<svg/>").unwrap();
        assert_eq!(
            vault.read_asset("attachments/test.png").unwrap(),
            "data:image/png;base64,cG5n"
        );
        assert!(vault.read_asset("attachments/test.svg").is_err());
        assert!(vault.read_asset("attachments/../visible.md").is_err());
    }

    #[test]
    fn list_uses_existing_frontmatter_title_without_rewriting_the_note() {
        let directory = tempfile::tempdir().unwrap();
        let vault = Vault::open(directory.path().into()).unwrap();
        let raw = "---\nid: 4483\ntitle: Display title\n---\n[[Another note]]\n";
        vault.write("notes/file-name.md", raw, None).unwrap();
        assert_eq!(vault.list().unwrap()[0].title, "Display title");
        assert_eq!(vault.read("notes/file-name.md").unwrap().raw, raw);
    }
}
