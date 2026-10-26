//! 官方 MCP Registry 在线目录（E3 ⑤）。
//!
//! 数据源：`GET https://registry.modelcontextprotocol.io/v0/servers`（免认证、可搜索）。
//! 这里只做「归一化」：把 Registry 的 server 包描述折叠成一条可直接落进
//! `.lattice/mcp.json` 的 stdio 启动配置；静态目录仍是断网兜底。
//!
//! 只收 stdio 包（npm → `npx -y`，pypi → `uvx`）；remote/SSE 条目留给 E4。

use serde_json::{Value, json};
use std::collections::HashSet;
use std::time::Duration;

const REGISTRY_URL: &str = "https://registry.modelcontextprotocol.io/v0/servers";
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESULTS: usize = 30;

/// 拉取并归一化在线目录；网络失败返回错误（调用方回退静态目录）。
pub async fn fetch(query: &str, limit: usize) -> Result<Vec<Value>, String> {
    let limit = limit.clamp(1, MAX_RESULTS);
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("Lattice/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("初始化 Registry 客户端失败：{error}"))?;
    let mut request = client.get(REGISTRY_URL).query(&[("limit", limit.to_string())]);
    if !query.trim().is_empty() {
        request = request.query(&[("search", query.trim())]);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("请求官方 Registry 失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("官方 Registry 返回 {}", response.status()));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析官方 Registry 响应失败：{error}"))?;
    let servers = normalize(&payload, limit);
    if servers.is_empty() {
        return Err("官方 Registry 没有可用的 stdio 条目".to_owned());
    }
    Ok(servers)
}

/// `{ servers: [{ server: {...}, _meta: {...} }] }` → 平铺条目（同 name 只留最新）。
pub fn normalize(payload: &Value, limit: usize) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in payload
        .get("servers")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let server = item.get("server").unwrap_or(item);
        let Some(name) = server.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(entry) = normalize_server(server) else {
            continue;
        };
        if !seen.insert(name.to_owned()) {
            continue;
        }
        out.push(entry);
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn normalize_server(server: &Value) -> Option<Value> {
    let name = server.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let packages = server.get("packages").and_then(Value::as_array)?;
    // 只收 stdio：remote/SSE 条目留给 E4；缺 transport 字段的老条目按 stdio 试。
    let package = packages
        .iter()
        .find(|item| item.pointer("/transport/type").and_then(Value::as_str) == Some("stdio"))
        .or_else(|| packages.iter().find(|item| item.pointer("/transport/type").is_none()))?;
    let registry_type = package
        .get("registryType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let identifier = package.get("identifier").and_then(Value::as_str)?;
    let (command, mut args) = match registry_type {
        "npm" => ("npx", vec![identifier.to_owned()]),
        "pypi" => ("uvx", vec![identifier.to_owned()]),
        _ => return None,
    };
    // runtimeArguments 在包名之前（如 `--yes`），packageArguments 在之后（业务参数）。
    let mut runtime_args = Vec::new();
    collect_args(package.get("runtimeArguments"), &mut runtime_args);
    // npm 默认加 `-y` 跳过交互确认；Registry 已给过 --yes/-y 时不重复。
    if command == "npx" && !runtime_args.iter().any(|arg| arg == "-y" || arg == "--yes") {
        runtime_args.push("-y".to_owned());
    }
    args = runtime_args.into_iter().chain(args).collect();
    collect_args(package.get("packageArguments"), &mut args);

    let mut required_env = Vec::new();
    for variable in package
        .get("environmentVariables")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let Some(env_name) = variable.get("name").and_then(Value::as_str) else {
            continue;
        };
        required_env.push(json!({
            "name": env_name,
            "hint": variable.get("description").and_then(Value::as_str).unwrap_or(""),
            "required": variable.get("isRequired").and_then(Value::as_bool).unwrap_or(false),
            "secret": variable.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
        }));
        if required_env.len() >= 12 {
            break;
        }
    }
    let docs = server
        .pointer("/repository/url")
        .and_then(Value::as_str)
        .or_else(|| server.get("websiteUrl").and_then(Value::as_str))
        .unwrap_or_default();
    Some(json!({
        "key": registry_key(name),
        "name": name.rsplit('/').next().unwrap_or(name),
        "fullName": name,
        "description": server.get("description").and_then(Value::as_str).unwrap_or(""),
        "version": server.get("version").and_then(Value::as_str).unwrap_or(""),
        "command": command,
        "args": args,
        "docs": docs,
        "requiredEnv": required_env,
    }))
}

fn collect_args(value: Option<&Value>, out: &mut Vec<String>) {
    for arg in value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        match arg.get("type").and_then(Value::as_str) {
            Some("named") => {
                let Some(arg_name) = arg.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let Some(arg_value) = arg.get("value").and_then(Value::as_str) else {
                    continue;
                };
                out.push(format!("--{arg_name}"));
                out.push(arg_value.to_owned());
            }
            _ => {
                if let Some(arg_value) = arg.get("value").and_then(Value::as_str) {
                    out.push(arg_value.to_owned());
                }
            }
        }
    }
}

/// Registry name（`com.pulsemcp/remote-filesystem`）→ 稳定短 key。
fn registry_key(name: &str) -> String {
    let mut key = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            key.push(ch.to_ascii_lowercase());
        } else {
            key.push('-');
        }
    }
    let key = key.trim_matches('-').to_owned();
    let key = if key.is_empty() { "registry".to_owned() } else { key };
    key.chars().take(48).collect()
}

#[cfg(test)]
mod tests {
    use super::{normalize, registry_key};
    use serde_json::json;

    fn fixture() -> serde_json::Value {
        json!({
            "servers": [
                { "server": {
                    "name": "io.example/files",
                    "description": "文件工具",
                    "version": "1.2.0",
                    "repository": { "url": "https://github.com/example/files" },
                    "packages": [{
                        "registryType": "npm",
                        "identifier": "@example/files-mcp",
                        "transport": { "type": "stdio" },
                        "runtimeArguments": [{ "value": "--yes", "type": "positional" }],
                        "packageArguments": [{ "type": "named", "name": "root", "value": "/tmp" }],
                        "environmentVariables": [
                            { "name": "FILES_TOKEN", "description": "访问令牌", "isRequired": true, "isSecret": true }
                        ]
                    }]
                }},
                { "server": {
                    "name": "io.example/files",
                    "description": "旧版本应被忽略",
                    "version": "1.0.0",
                    "packages": [{ "registryType": "npm", "identifier": "old", "transport": { "type": "stdio" } }]
                }},
                { "server": {
                    "name": "io.example/remote",
                    "packages": [{ "registryType": "npm", "identifier": "remote", "transport": { "type": "sse" } }]
                }},
                { "server": {
                    "name": "io.example/python",
                    "packages": [{ "registryType": "pypi", "identifier": "example-mcp", "transport": { "type": "stdio" } }]
                }},
                { "server": {
                    "name": "io.example/docker",
                    "packages": [{ "registryType": "oci", "identifier": "example", "transport": { "type": "stdio" } }]
                }}
            ]
        })
    }

    #[test]
    fn normalizes_stdio_packages_and_dedupes_by_name() {
        let entries = normalize(&fixture(), 30);
        assert_eq!(entries.len(), 2, "npm + pypi 保留，sse / oci 跳过");

        let files = &entries[0];
        assert_eq!(files["key"], "io-example-files");
        assert_eq!(files["name"], "files");
        assert_eq!(files["command"], "npx");
        assert_eq!(files["args"], json!(["--yes", "@example/files-mcp", "--root", "/tmp"]));
        assert_eq!(files["docs"], "https://github.com/example/files");
        assert_eq!(files["requiredEnv"][0]["name"], "FILES_TOKEN");
        assert_eq!(files["requiredEnv"][0]["secret"], true);

        assert_eq!(entries[1]["command"], "uvx");
        assert_eq!(entries[1]["args"], json!(["example-mcp"]));
    }

    #[test]
    fn registry_key_is_stable_and_bounded() {
        assert_eq!(registry_key("com.pulsemcp/remote-filesystem"), "com-pulsemcp-remote-filesystem");
        assert_eq!(registry_key("///"), "registry");
        assert!(registry_key(&"a".repeat(120)).len() <= 48);
    }

    #[test]
    fn empty_payload_stays_empty() {
        assert!(normalize(&json!({}), 10).is_empty());
        assert!(normalize(&json!({ "servers": [] }), 10).is_empty());
    }
}
