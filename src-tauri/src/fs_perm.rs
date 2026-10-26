//! Unix 文件权限收敛（Windows 保持默认 ACL，函数为空操作）。
//!
//! - 内部目录 `.lattice/` 创建为 0700；
//! - 内部状态文件（审计、单实例锁）收紧为 0600；
//! - 原子写覆盖时沿用原文件 mode，新文件落到 0644（笔记/画布可被同机工具读取）。

use std::path::Path;

/// 创建目录；Unix 下新建目录使用 0700。已存在的目录不改动其权限。
pub(crate) fn create_private_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)
    }
}

/// 内部状态文件收紧为 0600；已存在的宽松文件也一并修正。
pub(crate) fn restrict_private_file(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// 读取原文件 mode（仅 Unix；其他平台返回 None）。
pub(crate) fn existing_mode(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .ok()
            .map(|metadata| metadata.permissions().mode() & 0o7777)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// 原子写落盘后修正 mode：覆盖沿用原 mode，新文件 0644（再受进程 umask 约束）。
/// 失败只告警——内容已经写入，权限修正不应把保存结果变成错误。
pub(crate) fn restore_written_mode(path: &Path, previous_mode: Option<u32>) {
    if let Err(error) = set_mode(path, previous_mode) {
        log::warn!("修正文件权限失败（{}）：{error}", path.display());
    }
}

/// 新文件的目标 mode：0644 扣掉进程 umask（Linux 从 /proc 读取）。
#[cfg(unix)]
pub(crate) fn new_file_mode() -> u32 {
    0o644 & !current_umask()
}

#[cfg(unix)]
fn current_umask() -> u32 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(status) = std::fs::read_to_string("/proc/self/status")
            && let Some(raw) = status
                .lines()
                .find(|line| line.starts_with("Umask:"))
                .and_then(|line| line.split_whitespace().nth(1))
            && let Ok(mask) = u32::from_str_radix(raw, 8)
        {
            return mask & 0o777;
        }
    }
    // 非 Linux（或 /proc 不可读）按常见默认值收敛：只去掉组/其他写位
    0o022
}

#[cfg(unix)]
fn set_mode(path: &Path, previous_mode: Option<u32>) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        path,
        std::fs::Permissions::from_mode(previous_mode.unwrap_or_else(new_file_mode)),
    )
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _previous_mode: Option<u32>) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        create_private_dir, existing_mode, new_file_mode, restore_written_mode,
        restrict_private_file,
    };

    #[cfg(unix)]
    #[test]
    fn private_dirs_are_created_with_0700() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("vault/.lattice");
        create_private_dir(&target).unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn restrict_private_file_tightens_existing_loose_mode() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("audit.jsonl");
        std::fs::write(&target, "{}").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o664)).unwrap();
        restrict_private_file(&target).unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn new_files_get_0644_and_overwrites_keep_original_mode() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("note.md");
        let previous_mode = existing_mode(&target);
        assert!(previous_mode.is_none());
        std::fs::write(&target, "first").unwrap();
        restore_written_mode(&target, previous_mode);
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, new_file_mode(), "新文件 0644 且受 umask 约束");

        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        let previous_mode = existing_mode(&target);
        std::fs::write(&target, "second").unwrap();
        restore_written_mode(&target, previous_mode);
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "覆盖写保留用户原有 mode");
    }
}
