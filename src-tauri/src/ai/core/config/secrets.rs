//! 密钥源（地基方案 §5.2）：密钥只来自环境变量或系统密钥服务，
//! 永不来自源码、配置文件或 SQLite。
//!
//! 解析优先级（W1b）：**env 覆盖优先，keyring 持久**——
//! 1. 环境变量 `LATTICE_PROVIDER__<ID>__API_KEY`（id 转大写、非字母数字转下划线）；
//! 2. 系统密钥服务（Windows 凭据管理器 / macOS 钥匙串，service=`Lattice`）。
//!
//! 写入侧只进密钥服务（env 无法跨进程写入）；所有 keyring 错误按「密钥不存在」
//! 处理并记日志，密钥服务的可用性由 `keyAvailable` 如实反映，不静默造假。

use serde::Serialize;

/// 密钥供给约定。新增来源 = 实现本 trait，不改动调用方。
#[allow(dead_code)]
pub trait SecretsVault: Send + Sync {
    /// 按 provider id 读取密钥；不存在或为空返回 `None`。
    fn load(&self, provider_id: &str) -> Option<String>;
}

/// 密钥写入错误（W1b）：平台不支持 / 服务不可用 / 参数非法。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStoreError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for SecretStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

/// 环境变量密钥源（只读覆盖源）。
/// 生产路径直接消费 `env_secret`/`resolve_secret` 自由函数；本结构体与
/// `KeyringSecretsVault` 是「新增来源 = 实现 trait」扩展缝的具名实现（地基 §5.2）。
#[allow(dead_code)]
pub struct EnvSecretsVault;

impl SecretsVault for EnvSecretsVault {
    fn load(&self, provider_id: &str) -> Option<String> {
        env_secret(provider_id)
    }
}

/// 便捷读取：按 provider id 从默认环境变量源解析密钥。
pub fn env_secret(provider_id: &str) -> Option<String> {
    let name = env_var_name(provider_id);
    std::env::var(&name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

pub(crate) fn env_var_name(provider_id: &str) -> String {
    format!(
        "LATTICE_PROVIDER__{}__API_KEY",
        provider_id
            .to_ascii_uppercase()
            .replace(|character: char| !character.is_ascii_alphanumeric(), "_")
    )
}

/// provider id → keyring account 名的约束：只允许字母数字与 `-_.`，
/// 既是注入防线，也保证与 env 变量推导规则可互推。
pub(crate) fn keyring_account(provider_id: &str) -> Option<String> {
    let id = provider_id.trim();
    if id.is_empty() || id.len() > 120 {
        return None;
    }
    if !id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return None;
    }
    Some(id.to_owned())
}

const KEYRING_SERVICE: &str = "Lattice";

/// 测试专用：Windows 凭据管理器在并行测试下有瞬态竞态，涉及真实读写的测试
/// 统一拿这把锁串行执行（pub(crate) 供 small_model 的回环测试共用）。
#[cfg(test)]
pub(crate) static KEYRING_TEST_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 真实密钥服务回环测试开关：Windows 凭据管理器随系统可用，默认跑；
/// Linux 需要会话内存在 Secret Service（GNOME Keyring / KWallet），
/// 由 `LATTICE_KEYRING_TEST=1` 显式开启，避免无桌面会话的 CI 误报。
#[cfg(test)]
pub(crate) fn keyring_roundtrip_enabled() -> bool {
    if cfg!(windows) {
        return true;
    }
    std::env::var("LATTICE_KEYRING_TEST").is_ok_and(|value| value == "1")
}

fn keyring_entry(provider_id: &str) -> Result<keyring::Entry, SecretStoreError> {
    let account = keyring_account(provider_id).ok_or_else(|| SecretStoreError {
        code: "INVALID_PROVIDER_ID".to_owned(),
        message: "provider id 只允许字母数字与 -_.（≤120 字符）".to_owned(),
    })?;
    keyring::Entry::new(KEYRING_SERVICE, &account).map_err(|error| SecretStoreError {
        code: "SECRET_SERVICE_UNAVAILABLE".to_owned(),
        message: error.to_string(),
    })
}

/// 系统密钥服务源（W1b）：Windows 凭据管理器 / macOS 钥匙串。
/// 平台无可用后端时（如 Linux 未启用 feature，回退 mock store）读取恒为 None。
/// 生产路径直接消费 `keyring_secret`/`store_secret` 自由函数（见 EnvSecretsVault 注）。
#[allow(dead_code)]
pub struct KeyringSecretsVault;

impl SecretsVault for KeyringSecretsVault {
    fn load(&self, provider_id: &str) -> Option<String> {
        keyring_secret(provider_id)
    }
}

/// 从系统密钥服务读取；无条目返回 None，其余错误重试一次后仍失败才按 None 处理
/// （Windows 凭据管理器在并发/高负载下有瞬态失败，直接吞掉会造成「密钥时有时无」）。
pub fn keyring_secret(provider_id: &str) -> Option<String> {
    let entry = keyring_entry(provider_id).ok()?;
    let mut read = entry.get_password();
    if let Err(error) = &read {
        // NoEntry 是确定性的「不存在」，不重试；其余错误短暂等待后重试一次
        if !matches!(error, keyring::Error::NoEntry) {
            std::thread::sleep(std::time::Duration::from_millis(25));
            read = entry.get_password();
        }
    }
    match read {
        Ok(password) if !password.trim().is_empty() => Some(password),
        Ok(_) => None,
        Err(keyring::Error::NoEntry) => None,
        Err(error) => {
            log::warn!("keyring 读取失败（按密钥不存在处理）：{error}");
            None
        }
    }
}

/// 把真实密钥写入系统密钥服务（W1b 装配点：ai_settings_save 保存边界调用）。
pub fn store_secret(provider_id: &str, secret: &str) -> Result<(), SecretStoreError> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Err(SecretStoreError {
            code: "EMPTY_SECRET".to_owned(),
            message: "密钥内容为空".to_owned(),
        });
    }
    if secret.starts_with("masked:") {
        return Err(SecretStoreError {
            code: "MASKED_SECRET".to_owned(),
            message: "掩码不是可用密钥，拒绝写入密钥服务".to_owned(),
        });
    }
    let entry = keyring_entry(provider_id)?;
    entry.set_password(secret).map_err(|error| SecretStoreError {
        code: "SECRET_SERVICE_WRITE_FAILED".to_owned(),
        message: error.to_string(),
    })
}

/// 保存载荷 → 系统密钥服务：只写入真实 Key（非空、非掩码），
/// 返回未能持久化的 provider 警告。警告不含密钥内容，可安全回传前端。
///
/// 放在命令边界而非 `WorkspaceService`：服务层只负责脱敏文档落盘，
/// 对齐测试（parity）回放服务时不会触碰真实密钥服务。
pub fn store_document_secrets(document: &serde_json::Value) -> Vec<serde_json::Value> {
    let mut warnings = Vec::new();
    let Some(providers) = document
        .get("providers")
        .and_then(serde_json::Value::as_array)
    else {
        return warnings;
    };
    for provider in providers {
        let Some(id) = provider.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(key) = provider.get("apiKey").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let trimmed = key.trim();
        if trimmed.is_empty() || trimmed.starts_with("masked:") {
            continue; // 空值 = 沿用已存密钥；掩码 = 服务端回显，均不入密钥服务
        }
        if let Err(error) = store_secret(id, trimmed) {
            log::warn!("密钥写入系统密钥服务失败（provider={id}）：{error}");
            warnings.push(serde_json::json!({
                "providerId": id,
                "code": error.code,
                "message": error.message,
            }));
        }
    }
    warnings
}

/// 删除密钥服务中的条目；条本就不存在视为成功（返回 false 供调用方知悉）。
/// 预留：provider 删除后的密钥清理 UI（keyring 无枚举 API，按 id 定点删）。
#[allow(dead_code)]
pub fn delete_secret(provider_id: &str) -> Result<bool, SecretStoreError> {
    let entry = keyring_entry(provider_id)?;
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(SecretStoreError {
            code: "SECRET_SERVICE_DELETE_FAILED".to_owned(),
            message: error.to_string(),
        }),
    }
}

/// E4：MCP `envRef` 通用引用解析（不按 provider id 推导变量名）。
///
/// 支持的形态（整值引用，不做字符串内插）：
/// - `env:NAME` / `${env:NAME}` → 环境变量；
/// - `secret:NAME` / `${secret:NAME}` → 系统密钥服务（account = NAME）；
/// - `envRef:NAME` / `${envRef:NAME}` → 环境变量（兼容配置字段名写法）。
///
/// 非引用形态返回 `None`（由调用方按字面量处理）；引用无效或未解析到同样
/// 返回 `None`。错误信息只带变量名，绝不含密钥内容。
pub fn resolve_env_reference(raw: &str) -> Option<String> {
    let text = raw.trim();
    let inner = text
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'))
        .unwrap_or(text);
    let (kind, name) = inner.split_once(':')?;
    let name = name.trim();
    if name.is_empty() || name.len() > 200 {
        return None;
    }
    match kind.trim().to_ascii_lowercase().as_str() {
        "env" | "envref" => {
            if !is_env_name(name) {
                return None;
            }
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        }
        "secret" | "keyring" => {
            if name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
            {
                keyring_secret(name)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 该值是否是密钥引用（而不是可直接注入的字面量）。
pub fn is_env_reference(raw: &str) -> bool {
    let text = raw.trim();
    let inner = text
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'))
        .unwrap_or(text);
    match inner.split_once(':') {
        Some((kind, name)) => {
            matches!(
                kind.trim().to_ascii_lowercase().as_str(),
                "env" | "envref" | "secret" | "keyring"
            ) && !name.trim().is_empty()
        }
        None => false,
    }
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// 装配点统一入口（W1b）：env 覆盖优先，keyring 持久兜底。
pub fn resolve_secret(provider_id: &str) -> Option<String> {
    resolve_precedence(env_secret(provider_id), keyring_secret(provider_id))
}

/// 解析优先级（纯函数，测试钉死）：env 有值时压过 keyring。
pub(crate) fn resolve_precedence(env_value: Option<String>, keyring_value: Option<String>) -> Option<String> {
    env_value.or(keyring_value)
}

#[cfg(test)]
mod tests {
    use super::{delete_secret, env_var_name, keyring_account, keyring_secret, resolve_secret, store_secret};
    use crate::ai::core::config::secrets::EnvSecretsVault;
    use crate::ai::core::config::secrets::SecretsVault;

    #[test]
    fn env_var_name_is_derived_from_provider_id() {
        // 不真的读取环境变量，只验证变量名推导规则
        let vault = EnvSecretsVault;
        assert_eq!(
            vault.load("nonexistent-provider-id-for-test"),
            None,
            "未设置的变量应返回 None 而不是报错"
        );
        assert_eq!(env_var_name("provider-default"), "LATTICE_PROVIDER__PROVIDER_DEFAULT__API_KEY");
        assert_eq!(env_var_name("a.b/c"), "LATTICE_PROVIDER__A_B_C__API_KEY");
    }

    #[test]
    fn keyring_account_rejects_injection_and_oversize() {
        assert_eq!(keyring_account("provider-default").as_deref(), Some("provider-default"));
        assert!(keyring_account("").is_none());
        assert!(keyring_account(&"x".repeat(121)).is_none());
        assert!(keyring_account("bad\nid").is_none(), "换行注入被拒");
        assert!(keyring_account("bad/id").is_none(), "斜杠被拒（防止跨 service 目录）");
    }

    #[test]
    fn store_rejects_empty_and_masked_secrets() {
        assert!(store_secret("w1b-store-test", "").is_err());
        assert!(store_secret("w1b-store-test", "masked:abcd").is_err(), "掩码不得进密钥服务");
    }

    // W1b 验收核心：系统密钥服务真实读写删回环。
    // Windows 凭据管理器 / Linux Secret Service 共用同一套断言。
    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn keyring_roundtrip_on_system_secret_service() {
        if !super::keyring_roundtrip_enabled() {
            eprintln!("跳过真实密钥服务回环：设置 LATTICE_KEYRING_TEST=1 后重跑");
            return;
        }
        let _guard = super::KEYRING_TEST_GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // 运行时拼接构造假密钥：仓库不得出现可用凭据字面量（W9 扫描红线同样约束本文件）
        let fake = format!("w1b-test-{}key", "demo-");
        let provider = "w1b-keyring-roundtrip";
        store_secret(provider, &fake).expect("写入系统密钥服务");
        let mut loaded = keyring_secret(provider);
        for _ in 0..5 {
            if loaded.is_some() { break; }
            std::thread::sleep(std::time::Duration::from_millis(50));
            loaded = keyring_secret(provider);
        }
        assert_eq!(loaded.as_deref(), Some(fake.as_str()));
        assert_eq!(resolve_secret(provider).as_deref(), Some(fake.as_str()));
        assert!(delete_secret(provider).unwrap());
        assert!(!delete_secret(provider).unwrap(), "重复删除返回 false");
        assert_eq!(keyring_secret(provider), None);
    }

    #[test]
    fn document_secrets_skip_empty_and_masked_and_report_invalid_ids() {
        let warnings = super::store_document_secrets(&serde_json::json!({
            "providers": [
                { "id": "bad/id", "apiKey": "demo-key-not-a-secret-warn" },
                { "id": "masked-provider", "apiKey": "masked:abcd" },
                { "id": "empty-provider", "apiKey": "" }
            ]
        }));
        assert_eq!(warnings.len(), 1, "只有非法 provider id 触发警告");
        assert_eq!(warnings[0]["providerId"], "bad/id");
        assert_eq!(warnings[0]["code"], "INVALID_PROVIDER_ID");
        assert!(
            !warnings[0].to_string().contains("demo-key"),
            "警告不得回传密钥内容"
        );
    }

    #[test]
    fn env_reference_resolves_only_known_forms() {
        let name = format!("LATTICE_E4_REF_{}", std::process::id());
        // SAFETY：测试仅在本进程内设置一次性变量，名字带 pid 避免并行冲突。
        unsafe { std::env::set_var(&name, "resolved-value") };
        for form in [
            format!("env:{name}"),
            format!("${{env:{name}}}"),
            format!("envRef:{name}"),
            format!("${{envRef:{name}}}"),
        ] {
            assert!(super::is_env_reference(&form), "{form} 应识别为引用");
            assert_eq!(super::resolve_env_reference(&form).as_deref(), Some("resolved-value"));
        }
        assert_eq!(super::resolve_env_reference(&format!("env:{}_MISSING", name)), None);
        assert!(!super::is_env_reference("plain-value"));
        assert!(!super::is_env_reference("https://example.com"));
        assert_eq!(super::resolve_env_reference("plain-value"), None);
        unsafe { std::env::remove_var(&name) };
    }

    #[test]
    fn resolve_precedence_env_wins_over_keyring() {
        assert_eq!(
            super::resolve_precedence(Some("env-key".to_owned()), Some("keyring-key".to_owned())),
            Some("env-key".to_owned()),
            "env 覆盖优先"
        );
        assert_eq!(
            super::resolve_precedence(None, Some("keyring-key".to_owned())),
            Some("keyring-key".to_owned()),
            "env 缺省时落 keyring"
        );
        assert_eq!(super::resolve_precedence(None, None), None);
    }
}
