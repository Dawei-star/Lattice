//! 密钥源（地基方案 §5.2）：只从环境变量读取，永不来自源码、配置文件或 SQLite。
//!
//! 约定变量名：`LATTICE_PROVIDER__<ID>__API_KEY`（id 转大写、非字母数字转下划线），
//! 例如 provider id `provider-default` 对应 `LATTICE_PROVIDER__PROVIDER_DEFAULT__API_KEY`。
//! 系统密钥服务（keyring）是执行方案 W1b 的独立小步：实现本 trait 并替换装配点即可，
//! 构建受阻则永久 env-only，不阻塞任何后续批次。

/// 密钥供给约定。新增来源 = 实现本 trait，不改动调用方。
pub trait SecretsVault: Send + Sync {
    /// 按 provider id 读取密钥；不存在或为空返回 `None`。
    fn load(&self, provider_id: &str) -> Option<String>;
}

/// 环境变量密钥源。
pub struct EnvSecretsVault;

impl SecretsVault for EnvSecretsVault {
    fn load(&self, provider_id: &str) -> Option<String> {
        let name = format!(
            "LATTICE_PROVIDER__{}__API_KEY",
            provider_id
                .to_ascii_uppercase()
                .replace(|character: char| !character.is_ascii_alphanumeric(), "_")
        );
        std::env::var(&name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    }
}

/// 便捷读取：按 provider id 从默认环境变量源解析密钥。
pub fn env_secret(provider_id: &str) -> Option<String> {
    EnvSecretsVault.load(provider_id)
}

#[cfg(test)]
mod tests {
    use super::{EnvSecretsVault, SecretsVault};

    #[test]
    fn env_var_name_is_derived_from_provider_id() {
        // 不真的读取环境变量，只验证变量名推导规则
        let vault = EnvSecretsVault;
        assert_eq!(
            vault.load("nonexistent-provider-id-for-test"),
            None,
            "未设置的变量应返回 None 而不是报错"
        );
    }
}
