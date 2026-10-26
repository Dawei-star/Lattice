//! MCP 客户端（E3，`doc/AI/地基/专家-Skill-MCP重构方案.md` §3.4）。
//!
//! v1 边界：stdio + Streamable HTTP 传输；这里只负责「配置归一化 →
//! 连接 → tools/list → 注册进 ToolRegistry → tools/call」这条链路需要的
//! 数据契约，连接生命周期与协议细节在 `client`。
//!
//! 安全基线：MCP 注解只作默认、缺省按高风险（destructive 缺省为 true）；
//! 工具面按 `mcp.servers` 绑定裁剪——没绑定就不可见；env 支持
//! `env:` / `${env:}` / `secret:` 引用，密钥不落配置、不落日志。

pub(crate) mod client;
pub(crate) mod registry;

use crate::ai::core::agent::RiskLevel;
use crate::ai::core::config::secrets::{is_env_reference, resolve_env_reference};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// 单次 run 参与连接的 server 上限（与前端用户级上限一致）。
pub const MAX_SERVERS: usize = 8;
/// 单个 server 注册的工具上限（防止一个 server 撑爆工具面）。
pub const MAX_TOOLS_PER_SERVER: usize = 40;
/// 跨 server 注册的工具总上限（provider 工具面全局上限 64，给内置工具留余量）。
pub const MAX_TOTAL_TOOLS: usize = 40;

/// 归一化后的单个 MCP Server 配置（连接所需最小集）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub key: String,
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: String,
    pub enabled: bool,
}

impl McpServerConfig {
    /// 数组条目或对象条目 → 配置；缺连接信息时返回 None（与前端「未配好不入列」一致）。
    pub fn from_value(key_hint: Option<&str>, raw: &Value) -> Option<Self> {
        let object = raw.as_object()?;
        let key = key_hint
            .or_else(|| object.get("key").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())?
            .chars()
            .take(120)
            .collect::<String>();
        let url = object
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .chars()
            .take(500)
            .collect::<String>();
        let transport = match object
            .get("transport")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
        {
            "stdio" => "stdio",
            "http" | "streamable-http" | "streamable_http" | "sse" => "http",
            _ if !url.is_empty() => "http",
            _ => "stdio",
        };
        let command = object
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .chars()
            .take(500)
            .collect::<String>();
        if (transport == "stdio" && command.is_empty())
            || (transport == "http" && !url.starts_with("http://") && !url.starts_with("https://"))
        {
            return None;
        }
        let args = object
            .get("args")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|item| item.chars().take(500).collect())
                    .take(64)
                    .collect()
            })
            .unwrap_or_default();
        let env = parse_env(object);
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&key)
            .chars()
            .take(120)
            .collect();
        Some(Self {
            key,
            name,
            transport: transport.to_owned(),
            command,
            args,
            env,
            url,
            enabled: object.get("enabled").and_then(Value::as_bool) != Some(false),
        })
    }

    /// 请求里的 `mcpServers`（数组或对象两种形态，兼容 Claude/Cursor 配置粘贴）。
    pub fn from_request(request: &Value) -> Vec<Self> {
        parse_servers(request.get("mcpServers").unwrap_or(&Value::Null))
    }

    /// 连接缓存键：配置变更（命令/参数/环境/URL）即重连。
    /// 环境值做摘要，避免明文密钥在内存里多留一份。
    pub fn fingerprint(&self) -> String {
        let mut parts = vec![
            self.key.clone(),
            self.transport.clone(),
            self.command.clone(),
            self.url.clone(),
        ];
        parts.extend(self.args.iter().cloned());
        for (name, value) in &self.env {
            parts.push(format!("{name}={}", digest_ref(value)));
        }
        parts.join("\u{1f}")
    }

    /// E4：把 `env` 里的 `env:NAME` / `${env:NAME}` / `secret:NAME` 引用解析成
    /// 真实值；任一引用解析失败即返回错误（不带明文），由连接层降级该 server。
    pub fn resolved_env(&self) -> Result<BTreeMap<String, String>, String> {
        let mut resolved = BTreeMap::new();
        for (name, value) in &self.env {
            if is_env_reference(value) {
                match resolve_env_reference(value) {
                    Some(secret) => {
                        resolved.insert(name.clone(), secret);
                    }
                    None => {
                        return Err(format!(
                            "MCP Server「{}」的环境变量 {name} 引用未解析到（请检查变量/密钥是否已配置）",
                            self.name
                        ));
                    }
                }
            } else {
                resolved.insert(name.clone(), value.clone());
            }
        }
        Ok(resolved)
    }
}

/// `env` 与 `envRef` 合并：`envRef` 的值按 `env:NAME` 引用处理。
fn parse_env(object: &serde_json::Map<String, Value>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for (field, prefix) in [("env", ""), ("envRef", "env:")] {
        let Some(items) = object.get(field).and_then(Value::as_object) else {
            continue;
        };
        for (name, value) in items {
            if name.is_empty() || !value.is_string() || env.contains_key(name) {
                continue;
            }
            let raw = value.as_str().unwrap_or_default().trim();
            if raw.is_empty() {
                continue;
            }
            let value = if prefix.is_empty() {
                raw.chars().take(500).collect::<String>()
            } else {
                format!("{prefix}{}", raw.chars().take(200).collect::<String>())
            };
            env.insert(name.chars().take(200).collect::<String>(), value);
            if env.len() >= 32 {
                return env;
            }
        }
    }
    env
}

/// 缓存指纹里的短摘要（FNV-1a 64），不用于任何密码学用途。
fn digest_ref(value: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 解析 `mcpServers`：数组按 `key` 取值，对象按 map key 取值。
pub fn parse_servers(value: &Value) -> Vec<McpServerConfig> {
    let mut configs = Vec::new();
    match value {
        Value::Array(items) => {
            for item in items {
                if let Some(config) = McpServerConfig::from_value(None, item) {
                    configs.push(config);
                }
                if configs.len() >= MAX_SERVERS {
                    break;
                }
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                if let Some(config) = McpServerConfig::from_value(Some(key), item) {
                    configs.push(config);
                }
                if configs.len() >= MAX_SERVERS {
                    break;
                }
            }
        }
        _ => {}
    }
    configs
}

/// 注册到工具面/注册表的 MCP 工具条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    /// 模型可见名：`mcp__<server>__<tool>`。
    pub external_name: String,
    pub description: String,
    pub input_schema: Value,
    pub risk_level: RiskLevel,
    pub open_world: bool,
}

/// 一次 run 的连接结果（连接失败的 server 只记状态，不阻断 run）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRunPlan {
    pub tools: Vec<McpToolInfo>,
    pub statuses: Vec<McpServerStatus>,
}

/// IPC / 事件用的 server 状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub key: String,
    pub name: String,
    pub transport: String,
    /// `connected` | `idle` | `disabled` | `error`
    pub state: &'static str,
    pub tool_count: usize,
    pub error: Option<String>,
    pub tools: Vec<McpToolInfo>,
}

impl McpServerStatus {
    pub fn skipped(config: &McpServerConfig, state: &'static str, error: Option<String>) -> Self {
        Self {
            key: config.key.clone(),
            name: config.name.clone(),
            transport: config.transport.clone(),
            state,
            tool_count: 0,
            error,
            tools: Vec::new(),
        }
    }
}

/// 注解 → 风险等级（方案 §3.4 映射表；注解不可信，缺省按高风险）。
pub fn risk_level_from_annotations(
    read_only: Option<bool>,
    destructive: Option<bool>,
) -> RiskLevel {
    match (read_only, destructive) {
        (Some(true), Some(false)) => RiskLevel::L0,
        (Some(true), _) => RiskLevel::L1,
        _ => RiskLevel::L2,
    }
}

/// 模型可见工具名。server/tool 名字做稳定 slug：只保留字母数字与 `_`/`-`。
pub fn external_tool_name(server: &str, tool: &str) -> String {
    format!("mcp__{}__{}", slug(server), slug(tool))
}

pub fn is_mcp_tool(name: &str) -> bool {
    name.starts_with("mcp__")
}

/// 名字规范化（slug）：用于工具名与绑定匹配，保证 OpenAI function name 合法。
pub fn slug(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push('_');
        }
        if out.len() >= 24 {
            break;
        }
    }
    if out.is_empty() { "server".to_owned() } else { out }
}

#[cfg(test)]
mod tests {
    use super::{
        McpServerConfig, external_tool_name, is_mcp_tool, parse_servers,
        risk_level_from_annotations, slug,
    };
    use crate::ai::core::agent::RiskLevel;
    use serde_json::json;

    #[test]
    fn annotations_map_to_conservative_risk() {
        assert_eq!(risk_level_from_annotations(Some(true), Some(false)), RiskLevel::L0);
        assert_eq!(risk_level_from_annotations(Some(true), None), RiskLevel::L1);
        assert_eq!(risk_level_from_annotations(Some(true), Some(true)), RiskLevel::L1);
        assert_eq!(risk_level_from_annotations(Some(false), Some(false)), RiskLevel::L2);
        assert_eq!(risk_level_from_annotations(None, None), RiskLevel::L2);
        assert_eq!(risk_level_from_annotations(None, Some(true)), RiskLevel::L2);
    }

    #[test]
    fn parses_array_and_object_forms_and_drops_incomplete() {
        let array = parse_servers(&json!([
            { "key": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] },
            { "key": "bad", "transport": "stdio" },
            { "key": "web", "url": "https://example.com/mcp" }
        ]));
        assert_eq!(array.len(), 2);
        assert_eq!(array[0].key, "fs");
        assert_eq!(array[0].transport, "stdio");
        assert_eq!(array[1].transport, "http");

        let object = parse_servers(&json!({
            "git": { "command": "uvx", "args": ["mcp-server-git"], "env": { "TOKEN": "x" } }
        }));
        assert_eq!(object.len(), 1);
        assert_eq!(object[0].key, "git");
        assert_eq!(object[0].env.get("TOKEN").map(String::as_str), Some("x"));
        assert!(!object[0].fingerprint().is_empty());

        assert_eq!(
            McpServerConfig::from_request(&json!({ "mcpServers": [] })).len(),
            0
        );
    }

    #[test]
    fn env_refs_resolve_and_never_leak_plaintext_in_fingerprint() {
        let name = "LATTICE_E4_MCP_TEST_SECRET";
        // SAFETY：测试内设置一次性变量，固定名由本测试独占。
        unsafe { std::env::set_var(name, "mcp-secret-value") };
        let configs = parse_servers(&json!({
            "fs": {
                "command": "npx",
                "env": { "TOKEN": format!("${{env:{name}}}"), "LITERAL": "plain" },
                "envRef": { "API_KEY": name }
            }
        }));
        unsafe { std::env::remove_var(name) };
        let config = &configs[0];
        assert_eq!(config.env.get("LITERAL").map(String::as_str), Some("plain"));
        assert_eq!(config.env.get("API_KEY"), Some(&format!("env:{name}")));
        assert!(!config.fingerprint().contains("plain"));
        assert!(!config.fingerprint().contains("mcp-secret-value"));

        let resolved = parse_servers(&json!({
            "fs": { "command": "npx", "envRef": { "API_KEY": "PATH" } }
        }))
        .pop()
        .expect("配置应解析成功");
        assert!(resolved.resolved_env().unwrap().contains_key("API_KEY"));

        let missing = parse_servers(&json!({
            "fs": { "command": "npx", "env": { "TOKEN": "env:LATTICE_E4_MCP_NOT_SET" } }
        }))
        .pop()
        .expect("配置应解析成功");
        let error = missing.resolved_env().unwrap_err();
        assert!(error.contains("TOKEN"), "错误只提到变量名：{error}");
        assert!(error.contains("未解析到"));
    }

    #[test]
    fn tool_names_are_namespaced_and_slugged() {
        assert_eq!(external_tool_name("my server", "read file"), "mcp__my_server__read_file");
        assert!(is_mcp_tool("mcp__fs__read"));
        assert!(!is_mcp_tool("lattice_file_read"));
        assert_eq!(slug(""), "server");
        assert_eq!(slug("a/b@c"), "a_b_c");
    }
}
