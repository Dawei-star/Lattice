//! MCP 连接生命周期与工具调用（E3 stdio / E4 Streamable HTTP + elicitation）。
//!
//! - 官方 `rmcp` SDK（client + transport-child-process + streamable HTTP）；
//! - 懒连接：第一次真正需要工具时才启动子进程/发起 HTTP；配置指纹变化即重连；
//! - 连接/列表/调用都有超时，失败只降级该 server，不阻断 AI run；
//! - env 引用（`env:KEY` / `${env:KEY}` / `secret:KEY`）在这里解析后注入，
//!   解析失败只报变量名，不泄露明文；
//! - elicitation：server 请求用户输入时，通过事件把表单抛给前端并挂起等待
//!   `mcp_elicitation_reply`；超时/无前端则按 decline 降级，不阻断调用；
//! - 子进程清理交给 `RunningService` 的 DropGuard（连接被替换/进程退出时取消）。

use super::{
    MAX_SERVERS, MAX_TOTAL_TOOLS, MAX_TOOLS_PER_SERVER, McpRunPlan, McpServerConfig,
    McpServerStatus, McpToolInfo, external_tool_name, risk_level_from_annotations,
};
use rmcp::ClientHandler;
use rmcp::ServiceExt;
use rmcp::model::{
    CallToolRequestParams, ClientCapabilities, ClientConfig, ElicitRequestParams, ElicitResult,
    ElicitationAction, ElicitationCapability, FormElicitationCapability, Implementation,
};
use rmcp::service::{RequestContext, RoleClient, RunningService};
use rmcp::transport::{ConfigureCommandExt, IntoTransport, TokioChildProcess};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::oneshot;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// elicitation 等待用户输入的上限；超时按 decline 处理。
const ELICIT_TIMEOUT: Duration = Duration::from_secs(300);
const RESULT_TEXT_MAX_CHARS: usize = 4_000;

/// run 内的 elicitation 上下文：把表单事件写进该 run 的事件流。
#[derive(Clone)]
pub struct ElicitationSink {
    run_id: String,
    emit: Arc<dyn Fn(Value) + Send + Sync>,
}

impl ElicitationSink {
    pub fn new(run_id: impl Into<String>, emit: Arc<dyn Fn(Value) + Send + Sync>) -> Self {
        Self {
            run_id: run_id.into(),
            emit,
        }
    }
}

/// 用户对 elicitation 的回复（IPC `mcp_elicitation_reply` 写入）。
pub struct ElicitationAnswer {
    pub action: String,
    pub content: Option<Value>,
}

#[derive(Clone, Default)]
struct ClientState {
    sink: Arc<Mutex<Option<ElicitationSink>>>,
}

/// 每个连接一个 handler：声明 elicitation 能力，并把请求转成前端事件。
#[derive(Clone)]
struct LatticeClient {
    state: ClientState,
    server: String,
}

impl ClientHandler for LatticeClient {
    fn get_info(&self) -> ClientConfig {
        let mut capabilities = ClientCapabilities::default();
        capabilities.elicitation =
            Some(ElicitationCapability::new().with_form(FormElicitationCapability::new()));
        ClientConfig::new(
            capabilities,
            Implementation::new("Lattice", env!("CARGO_PKG_VERSION")),
        )
    }

    async fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> Result<ElicitResult, rmcp::model::ErrorData> {
        let sink = self
            .state
            .sink
            .lock()
            .ok()
            .and_then(|state| state.clone());
        let Some(sink) = sink else {
            // 没有前端上下文（例如状态探测）：按默认行为拒绝。
            return Ok(ElicitResult::new(ElicitationAction::Decline));
        };
        let (message, schema) = match request {
            ElicitRequestParams::FormElicitationParams {
                message,
                requested_schema,
                ..
            } => (
                message,
                serde_json::to_value(&requested_schema)
                    .unwrap_or_else(|_| json!({ "type": "object", "properties": {} })),
            ),
            ElicitRequestParams::UrlElicitationParams { message, .. } => {
                // URL 模式暂不接管浏览器：明确拒绝，避免服务端一直等待。
                log::info!("MCP Server「{}」请求 URL elicitation，当前版本按拒绝处理：{message}", self.server);
                return Ok(ElicitResult::new(ElicitationAction::Decline));
            }
            _ => return Ok(ElicitResult::new(ElicitationAction::Decline)),
        };
        let id = next_elicit_id();
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut pending) = pending_elicitations().lock() {
            pending.insert(id.clone(), sender);
        }
        (sink.emit)(json!({
            "type": "mcp_elicitation",
            "id": id,
            "runId": sink.run_id,
            "server": self.server,
            "message": message,
            "requestedSchema": schema,
        }));
        let answer = match tokio::time::timeout(ELICIT_TIMEOUT, receiver).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) | Err(_) => {
                if let Ok(mut pending) = pending_elicitations().lock() {
                    pending.remove(&id);
                }
                return Ok(ElicitResult::new(ElicitationAction::Decline));
            }
        };
        if let Ok(mut pending) = pending_elicitations().lock() {
            pending.remove(&id);
        }
        Ok(match answer.action.as_str() {
            "accept" => ElicitResult::new(ElicitationAction::Accept)
                .with_content(answer.content.unwrap_or_else(|| json!({}))),
            "cancel" => ElicitResult::new(ElicitationAction::Cancel),
            _ => ElicitResult::new(ElicitationAction::Decline),
        })
    }
}

fn pending_elicitations() -> &'static Mutex<HashMap<String, oneshot::Sender<ElicitationAnswer>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<ElicitationAnswer>>>> =
        OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_elicit_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("mcp-elicit-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// 前端回复 elicitation；`action` 只接受 accept/decline/cancel。
pub fn reply_elicitation(id: &str, action: &str, content: Option<Value>) -> Result<(), String> {
    if !matches!(action, "accept" | "decline" | "cancel") {
        return Err(format!("未知的 elicitation 动作：{action}"));
    }
    if action == "accept" && !matches!(content, Some(Value::Object(_))) {
        return Err("accept 必须携带对象形式的表单内容".to_owned());
    }
    let sender = pending_elicitations()
        .lock()
        .map_err(|error| error.to_string())?
        .remove(id)
        .ok_or_else(|| "MCP 输入请求已结束或不存在".to_owned())?;
    sender
        .send(ElicitationAnswer {
            action: action.to_owned(),
            content,
        })
        .map_err(|_| "MCP 输入请求已取消".to_owned())
}

/// 已建立的连接（配置 + 服务端工具快照 + elicitation 通道）。
pub struct McpConnection {
    pub config: McpServerConfig,
    fingerprint: String,
    state: ClientState,
    /// 持有连接即持有生命周期：Drop 时 rmcp 取消传输/子进程。
    #[allow(dead_code)]
    service: RunningService<RoleClient, LatticeClient>,
    tools: Vec<McpToolInfo>,
}

impl McpConnection {
    async fn call(
        &self,
        tool: &str,
        args: &Value,
        sink: Option<ElicitationSink>,
    ) -> Result<Value, String> {
        if let Ok(mut state) = self.state.sink.lock() {
            *state = sink;
        }
        let arguments = args.as_object().cloned().unwrap_or_default();
        let params = CallToolRequestParams::new(tool.to_owned()).with_arguments(arguments);
        let result = tokio::time::timeout(CALL_TIMEOUT, self.service.call_tool(params)).await;
        if let Ok(mut state) = self.state.sink.lock() {
            *state = None;
        }
        let result = result
            .map_err(|_| format!("MCP 工具 {tool} 调用超时"))?
            .map_err(|error| format!("MCP 工具 {tool} 调用失败：{error}"))?;
        let is_error = result.is_error.unwrap_or(false);
        let content = content_text(&serde_json::to_value(&result.content).unwrap_or(Value::Null));
        let mut payload = json!({
            "status": if is_error { "failed" } else { "completed" },
            "server": self.config.key,
            "tool": tool,
            "content": content.chars().take(RESULT_TEXT_MAX_CHARS).collect::<String>(),
            "isError": is_error,
        });
        if let Some(structured) = result.structured_content {
            payload["structured"] = structured;
        }
        Ok(payload)
    }
}

fn content_text(content: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(items) = content.as_array() {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        parts.push(text.to_owned());
                    }
                }
                Some(kind) => parts.push(format!("[{kind}]")),
                None => {}
            }
        }
    }
    parts.join("\n")
}

fn shared_runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_io()
            .enable_time()
            .thread_name("lattice-mcp")
            .build()
            .expect("MCP 运行时初始化失败")
    })
}

fn cache() -> &'static Mutex<BTreeMap<String, Arc<McpConnection>>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, Arc<McpConnection>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn cached(config: &McpServerConfig) -> Option<Arc<McpConnection>> {
    let cache = cache().lock().ok()?;
    let connection = cache.get(&config.key)?;
    (connection.fingerprint == config.fingerprint()).then(|| connection.clone())
}

/// 确保连接就绪（已连接且配置未变则复用）。
pub fn ensure_connected(config: &McpServerConfig) -> Result<Arc<McpConnection>, String> {
    if let Some(connection) = cached(config) {
        return Ok(connection);
    }
    let connection = Arc::new(shared_runtime().block_on(connect(config))?);
    if let Ok(mut cache) = cache().lock() {
        cache.insert(config.key.clone(), connection.clone());
    }
    Ok(connection)
}

async fn connect(config: &McpServerConfig) -> Result<McpConnection, String> {
    if config.transport == "http" {
        // E4：Streamable HTTP（MCP 规范 2025-03-26 起的统一传输）。
        let transport =
            rmcp::transport::StreamableHttpClientTransport::from_uri(config.url.clone());
        connect_service(config, transport).await
    } else {
        let env = config.resolved_env()?;
        let transport = spawn_transport(config, &env)?;
        connect_service(config, transport).await
    }
}

async fn connect_service<T, E, A>(
    config: &McpServerConfig,
    transport: T,
) -> Result<McpConnection, String>
where
    T: IntoTransport<RoleClient, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    let state = ClientState::default();
    let client = LatticeClient {
        state: state.clone(),
        server: config.key.clone(),
    };
    let service = tokio::time::timeout(CONNECT_TIMEOUT, client.serve(transport))
        .await
        .map_err(|_| format!("连接 MCP Server「{}」超时", config.name))?
        .map_err(|error| format!("连接 MCP Server「{}」失败：{error}", config.name))?;
    let tools = tokio::time::timeout(LIST_TIMEOUT, service.list_all_tools())
        .await
        .map_err(|_| format!("读取 MCP Server「{}」工具列表超时", config.name))?
        .map_err(|error| format!("读取 MCP Server「{}」工具列表失败：{error}", config.name))?;
    Ok(McpConnection {
        config: config.clone(),
        fingerprint: config.fingerprint(),
        state,
        service,
        tools: describe_tools(config, tools),
    })
}

fn describe_tools(
    config: &McpServerConfig,
    tools: Vec<rmcp::model::Tool>,
) -> Vec<McpToolInfo> {
    let mut described = Vec::new();
    let mut seen = HashSet::new();
    for tool in tools.into_iter().take(MAX_TOOLS_PER_SERVER) {
        let name = tool.name.trim().to_owned();
        if name.is_empty() {
            continue;
        }
        let external_name = external_tool_name(&config.key, &name);
        if !seen.insert(external_name.clone()) {
            continue;
        }
        let annotations = tool.annotations.as_ref();
        let risk_level = risk_level_from_annotations(
            annotations.and_then(|hints| hints.read_only_hint),
            annotations.and_then(|hints| hints.destructive_hint),
        );
        let open_world = annotations
            .and_then(|hints| hints.open_world_hint)
            .unwrap_or(true);
        let mut description = tool
            .description
            .map(|value| value.into_owned())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("MCP Server「{}」提供的工具 {name}", config.name));
        if open_world {
            description.push_str("（数据将离开本机）");
        }
        described.push(McpToolInfo {
            server: config.key.clone(),
            name,
            external_name,
            description: description.chars().take(500).collect(),
            input_schema: Value::Object((*tool.input_schema).clone()),
            risk_level,
            open_world,
        });
    }
    described
}

/// 启动子进程：Windows 上 `npx` 这类命令是 `.cmd`，直接 spawn 会 ENOENT，
/// 失败后回退 `cmd /c` 包装（方案 §3.4 Windows 专项）。
fn spawn_transport(
    config: &McpServerConfig,
    env: &BTreeMap<String, String>,
) -> Result<TokioChildProcess, String> {
    let direct = build_command(&config.command, &config.args, env).configure(|_| {});
    match TokioChildProcess::new(direct) {
        Ok(transport) => Ok(transport),
        Err(error) => {
            #[cfg(windows)]
            {
                let mut args = vec!["/c".to_owned(), config.command.clone()];
                args.extend(config.args.iter().cloned());
                let wrapped = build_command("cmd", &args, env);
                return TokioChildProcess::new(wrapped).map_err(|retry| {
                    format!(
                        "启动 MCP Server「{}」失败：{error}（cmd /c 回退也失败：{retry}）",
                        config.name
                    )
                });
            }
            #[cfg(not(windows))]
            {
                Err(format!(
                    "启动 MCP Server「{}」失败：{error}",
                    config.name
                ))
            }
        }
    }
}

fn build_command(
    program: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command.args(args);
    // GUI 进程的 PATH 往往缺包管理器的安装目录（Node/uv 高频坑）：补一段再让配置覆盖。
    if !env.contains_key("PATH") && !env.contains_key("Path") {
        command.env("PATH", augmented_path());
    }
    command.envs(env);
    command
}

fn augmented_path() -> String {
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    let mut extras: Vec<String> = vec![
        "/usr/local/bin".to_owned(),
        "/opt/homebrew/bin".to_owned(),
        "/usr/local/sbin".to_owned(),
        "/opt/local/bin".to_owned(),
    ];
    if let Ok(home) = std::env::var("HOME") {
        extras.push(format!("{home}/.local/bin"));
        extras.push(format!("{home}/.npm-global/bin"));
        extras.push(format!("{home}/.cargo/bin"));
    }
    #[cfg(windows)]
    {
        if let Ok(app_data) = std::env::var("APPDATA") {
            extras.push(format!("{app_data}\\npm"));
        }
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            extras.push(format!("{user_profile}\\.cargo\\bin"));
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            extras.push(format!("{program_files}\\nodejs"));
        }
    }
    for extra in extras {
        if !parts.iter().any(|part| part == &extra) {
            parts.push(extra);
        }
    }
    #[cfg(windows)]
    return parts.join(";");
    #[cfg(not(windows))]
    return parts.join(":");
}

/// 第一次真正需要 MCP 工具时调用：逐个连接并汇总工具面（失败的 server 只记状态）。
pub fn prepare(configs: &[McpServerConfig]) -> McpRunPlan {
    let mut plan = McpRunPlan::default();
    let mut seen = HashSet::new();
    for config in configs.iter().take(MAX_SERVERS) {
        if !config.enabled {
            plan.statuses
                .push(McpServerStatus::skipped(config, "disabled", None));
            continue;
        }
        match ensure_connected(config) {
            Ok(connection) => {
                for tool in &connection.tools {
                    if plan.tools.len() >= MAX_TOTAL_TOOLS {
                        break;
                    }
                    if seen.insert(tool.external_name.clone()) {
                        plan.tools.push(tool.clone());
                    }
                }
                plan.statuses.push(McpServerStatus {
                    key: config.key.clone(),
                    name: config.name.clone(),
                    transport: config.transport.clone(),
                    state: "connected",
                    tool_count: connection.tools.len(),
                    error: None,
                    tools: connection.tools.clone(),
                });
            }
            Err(error) => {
                log::warn!("MCP Server「{}」连接失败：{error}", config.name);
                plan.statuses
                    .push(McpServerStatus::skipped(config, "error", Some(error)));
            }
        }
    }
    plan
}

/// 状态查询：`probe=false` 只报告已缓存的连接（不启动子进程）。
pub fn statuses(configs: &[McpServerConfig], probe: bool) -> Vec<McpServerStatus> {
    configs
        .iter()
        .take(MAX_SERVERS)
        .map(|config| {
            if !config.enabled {
                return McpServerStatus::skipped(config, "disabled", None);
            }
            let connection = if probe {
                ensure_connected(config).ok()
            } else {
                cached(config)
            };
            match connection {
                Some(connection) => McpServerStatus {
                    key: config.key.clone(),
                    name: config.name.clone(),
                    transport: config.transport.clone(),
                    state: "connected",
                    tool_count: connection.tools.len(),
                    error: None,
                    tools: connection.tools.clone(),
                },
                None if probe => McpServerStatus::skipped(
                    config,
                    "error",
                    Some("连接失败：Server 未响应".to_owned()),
                ),
                None => McpServerStatus::skipped(config, "idle", None),
            }
        })
        .collect()
}

/// 单个 server 的工具清单（未连接时为空）。
pub fn tools_for(server_key: &str) -> Vec<McpToolInfo> {
    cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(server_key).map(|connection| connection.tools.clone()))
        .unwrap_or_default()
}

/// 执行模型发来的 `mcp__<server>__<tool>` 调用。
pub fn call_external(
    external_name: &str,
    args: &Value,
    sink: Option<ElicitationSink>,
) -> Result<Value, String> {
    let target = {
        let cache = cache().lock().map_err(|error| error.to_string())?;
        cache.values().find_map(|connection| {
            connection
                .tools
                .iter()
                .find(|tool| tool.external_name == external_name)
                .map(|tool| (connection.clone(), tool.name.clone()))
        })
    };
    let Some((connection, tool)) = target else {
        return Err(format!("MCP 工具 {external_name} 尚未连接"));
    };
    shared_runtime().block_on(connection.call(&tool, args, sink))
}

/// `mcp_server_test`：强制连接一次并返回状态。
pub fn server_test(config: &McpServerConfig) -> Result<McpServerStatus, String> {
    let connection = ensure_connected(config)?;
    Ok(McpServerStatus {
        key: config.key.clone(),
        name: config.name.clone(),
        transport: config.transport.clone(),
        state: "connected",
        tool_count: connection.tools.len(),
        error: None,
        tools: connection.tools.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::{augmented_path, content_text, reply_elicitation};
    use serde_json::json;

    #[test]
    fn content_text_joins_text_blocks_and_marks_others() {
        let content = json!([
            { "type": "text", "text": "第一行" },
            { "type": "image", "data": "x" },
            { "type": "text", "text": "第二行" }
        ]);
        assert_eq!(content_text(&content), "第一行\n[image]\n第二行");
        assert_eq!(content_text(&json!(null)), "");
    }

    #[test]
    fn augmented_path_keeps_existing_entries() {
        let path = augmented_path();
        #[cfg(windows)]
        assert!(path.contains(';'));
        #[cfg(not(windows))]
        assert!(path.contains(':'));
    }

    #[test]
    fn elicitation_reply_rejects_unknown_id_and_action() {
        assert!(reply_elicitation("mcp-elicit-404", "accept", Some(json!({}))).is_err());
        assert!(reply_elicitation("mcp-elicit-404", "unknown", None).is_err());
        assert!(
            reply_elicitation("mcp-elicit-404", "accept", None)
                .unwrap_err()
                .contains("对象")
        );
    }

    #[test]
    fn http_transport_is_attempted_instead_of_unsupported() {
        use crate::ai::core::mcp::{McpServerConfig, client::prepare};
        let config = McpServerConfig {
            key: "remote".to_owned(),
            name: "Remote".to_owned(),
            transport: "http".to_owned(),
            command: String::new(),
            args: Vec::new(),
            env: Default::default(),
            // 保留端口：连接被立即拒绝，用来验证走 HTTP 分支而不是 unsupported。
            url: "http://127.0.0.1:9/mcp".to_owned(),
            enabled: true,
        };
        let plan = prepare(&[config]);
        assert_eq!(plan.statuses.len(), 1);
        assert_ne!(plan.statuses[0].state, "unsupported");
        assert_eq!(plan.statuses[0].state, "error");
        assert!(!plan.tools.iter().any(|tool| tool.server == "remote"));
    }

    /// 端到端冒烟：真的启动一个 stdio MCP Server（node 手写 JSON-RPC），
    /// 走完 initialize → tools/list → tools/call。默认 ignore：需要本机 node。
    #[test]
    #[ignore = "需要本机 node；本机验证命令：cargo test --lib mcp_smoke -- --ignored"]
    fn mcp_smoke_spawns_stdio_server_and_calls_tool() {
        use super::{call_external, ensure_connected};
        use crate::ai::core::mcp::McpServerConfig;
        use serde_json::json;
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("lattice-mcp-smoke-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        let script = dir.join("server.mjs");
        let mut file = std::fs::File::create(&script).expect("写入测试 Server");
        file.write_all(
            br#"let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let index;
  while ((index = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, index).trim();
    buf = buf.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'smoke', version: '0.1.0' } };
    } else if (message.method === 'tools/list') {
      result = { tools: [{ name: 'echo', description: 'echo arguments', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false } }] };
    } else if (message.method === 'tools/call') {
      result = { content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }] };
    } else {
      result = {};
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  }
});
"#,
        )
        .expect("写入测试 Server");

        let config = McpServerConfig {
            key: "smoke".to_owned(),
            name: "Smoke".to_owned(),
            transport: "stdio".to_owned(),
            command: "node".to_owned(),
            args: vec![script.to_string_lossy().into_owned()],
            env: Default::default(),
            url: String::new(),
            enabled: true,
        };
        let connection = ensure_connected(&config).expect("连接测试 Server");
        assert_eq!(connection.tools.len(), 1);
        assert_eq!(connection.tools[0].external_name, "mcp__smoke__echo");
        assert_eq!(
            connection.tools[0].risk_level,
            crate::ai::core::agent::RiskLevel::L0
        );

        let output = call_external("mcp__smoke__echo", &json!({ "text": "你好" }), None)
            .expect("调用测试 Server 工具");
        assert_eq!(output["status"], "completed");
        assert_eq!(output["content"], "{\"text\":\"你好\"}");
        assert_eq!(output["server"], "smoke");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端冒烟：server 在 tools/call 中反向请求 elicitation，客户端把表单抛给
    /// `ElicitationSink` 并等待 `reply_elicitation`，收到后把答复回传 server。
    #[test]
    #[ignore = "需要本机 node；本机验证命令：cargo test --lib mcp_elicitation_smoke -- --ignored"]
    fn mcp_elicitation_smoke_round_trips_user_input() {
        use super::{ElicitationSink, call_external, ensure_connected};
        use crate::ai::core::mcp::McpServerConfig;
        use serde_json::json;
        use std::io::Write;
        use std::sync::{Arc, Mutex};

        let dir = std::env::temp_dir().join(format!("lattice-mcp-elicit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        let script = dir.join("server.mjs");
        let mut file = std::fs::File::create(&script).expect("写入测试 Server");
        file.write_all(
            r#"let buf = '';
let pendingTool = null;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let index;
  while ((index = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, index).trim();
    buf = buf.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'elicit', version: '0.1.0' } } }) + '\n');
    } else if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ask', description: 'ask user', inputSchema: { type: 'object', properties: {} } }] } }) + '\n');
    } else if (message.method === 'tools/call') {
      pendingTool = message.id;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'elicitation/create', params: { message: '请输入名字', requestedSchema: { type: 'object', properties: { name: { type: 'string', title: '名字' } }, required: ['name'] } } }) + '\n');
    } else if (message.id === 900 && message.method === undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: pendingTool, result: { content: [{ type: 'text', text: JSON.stringify(message.result) }] } }) + '\n');
    }
  }
});
"#
            .as_bytes(),
        )
        .expect("写入测试 Server");

        let config = McpServerConfig {
            key: "elicit".to_owned(),
            name: "Elicit".to_owned(),
            transport: "stdio".to_owned(),
            command: "node".to_owned(),
            args: vec![script.to_string_lossy().into_owned()],
            env: Default::default(),
            url: String::new(),
            enabled: true,
        };
        ensure_connected(&config).expect("连接测试 Server");

        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let sink = ElicitationSink::new("run-test", {
            let events = events.clone();
            Arc::new(move |event| {
                if let Ok(mut events) = events.lock() {
                    events.push(event);
                }
            })
        });
        let worker = std::thread::spawn(move || {
            call_external("mcp__elicit__ask", &json!({}), Some(sink))
        });

        let mut answered = None;
        for _ in 0..200 {
            if let Ok(pending) = super::pending_elicitations().lock() {
                if let Some(id) = pending.keys().next().cloned() {
                    answered = Some(id);
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let id = answered.expect("server 的 elicitation 请求应挂起");
        super::reply_elicitation(&id, "accept", Some(json!({ "name": "Lattice" })))
            .expect("回复 elicitation");

        let output = worker.join().expect("等待工具调用").expect("工具调用应成功");
        assert_eq!(output["status"], "completed");
        assert!(
            output["content"].as_str().unwrap_or_default().contains("Lattice"),
            "server 应收到用户填写的内容：{output}"
        );
        let emitted = events.lock().expect("读取事件").clone();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0]["type"], "mcp_elicitation");
        assert_eq!(emitted[0]["server"], "elicit");
        assert_eq!(emitted[0]["requestedSchema"]["properties"]["name"]["title"], "名字");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
