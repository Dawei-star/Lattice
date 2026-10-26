//! 专家运行时（E1，`doc/AI/地基/专家-Skill-MCP重构方案.md` §3.2）。
//!
//! 把选中的专家从「只存储不生效的配置」变成运行时策略：run 开始时由
//! `resolve` 解析为 `ExpertRuntime`——system 文本（人格提示词 + 预载技能全文）、
//! 工具面白名单、写策略、轮数与路径黑名单；再由 `apply` 写进请求
//! （协议层据此组装 system 消息、过滤工具面）。全部接既有内核机制，
//! 不改 AgentRunner / run_worker 编排主干（地基 §9 扩展铁律）。
//!
//! 版本溯源：`prompt_versions` 随 `expert_loaded` 事件进 run 事件流
//! （E1c），形式 `expert:<id>@<version>` / `skill:<id>@<version>`。

use crate::workspace::WorkspaceService;
use serde_json::Value;

/// system 文本总上限（人格 12k + 预载技能；超出部分整块丢弃并告警）。
pub const EXPERT_SYSTEM_MAX_CHARS: usize = 24_000;
/// 单个预载技能正文上限（技能文件本体上限 30k，注入前再收紧）。
pub const EXPERT_SKILL_PRELOAD_MAX_CHARS: usize = 6_000;
/// 技能目录单条上限（name+description，约 200 token 的中文保守值）。
pub const EXPERT_SKILL_CATALOG_ENTRY_MAX_CHARS: usize = 300;
/// 技能目录总上限（超出后整条跳过并告警）。
pub const EXPERT_SKILL_CATALOG_MAX_CHARS: usize = 4_000;
/// `skill_load` 单次返回的正文上限。
pub const SKILL_LOAD_MAX_CHARS: usize = 8_000;
/// 内核注入的技能加载工具名（E2 渐进披露的 L2）。
pub const SKILL_LOAD_TOOL: &str = "skill_load";
/// 用户通过 `/` 显式调用的技能：单个正文上限（与 skill_load 一致）。
pub const INVOKED_SKILL_MAX_CHARS: usize = 8_000;
/// 用户显式调用技能的 system 总预算（超出的技能整条跳过）。
pub const INVOKED_SKILLS_MAX_CHARS: usize = 24_000;
/// 单条消息最多显式调用的技能数（防止误粘贴导致提示词膨胀）。
pub const INVOKED_SKILLS_MAX_COUNT: usize = 8;

/// 目录常驻的技能摘要（L1）：只带 id / 标题 / 一句话说明。
#[derive(Debug, Clone)]
pub struct SkillBrief {
    pub id: String,
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct ExpertRuntime {
    pub expert_id: String,
    pub expert_name: String,
    /// 注入协议层 system 消息的完整文本（人格 + 预载技能块）。
    pub system: String,
    /// 参与本次 run 的专家/技能版本（进 trace 事件）。
    pub prompt_versions: Vec<String>,
    /// 能力词表（read/search/write/mcp 或显式工具名）；空 = 默认 read+search。
    pub capabilities: Vec<String>,
    /// 写策略：disabled 禁写 / confirm 默认确认 / auto 允许 L0-L2 直执（L3 仍确认）。
    pub write_policy: WritePolicy,
    /// 专家声明的轮数上限（经 budget 只收紧地生效）。
    pub max_rounds: u32,
    /// 写路径前缀黑名单（已规范化）。
    pub scope_exclude: Vec<String>,
    /// discoverable 绑定的技能（只常驻目录，模型按需 `skill_load`）。
    pub exposed_skills: Vec<SkillBrief>,
    /// E3：允许暴露的 MCP Server（`mcp.servers` 的 key/name；`*` = 全部）。
    /// 空表 = 不暴露任何 MCP 工具（工具面与调度层一致裁剪）。
    pub mcp_servers: Vec<String>,
}

/// 写策略（E1 起从展示标签变成运行时策略）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WritePolicy {
    /// 禁写：写工具从工具面剥离，内核调度层同样拒绝
    Disabled,
    /// 默认：L0/L1 直执，L2/L3 等用户确认
    Confirm,
    /// 宽松：L0/L1/L2 直执，L3（删除/外发）仍确认
    Auto,
}

impl WritePolicy {
    fn parse(raw: &str) -> Self {
        match raw {
            "disabled" => Self::Disabled,
            "auto" => Self::Auto,
            _ => Self::Confirm,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Confirm => "confirm",
            Self::Auto => "auto",
        }
    }

    /// 是否允许写工具出现在工具面上。
    pub fn allows_writes(&self) -> bool {
        !matches!(self, Self::Disabled)
    }

    /// L2 风险是否免确认（只有 auto 放开；L3 永不免）。
    pub fn auto_approves_l2(&self) -> bool {
        matches!(self, Self::Auto)
    }
}

/// 人格模板变量：只替换已知变量，未知 `{{…}}` 原样保留
/// （用户手写提示词不做 fail-fast，避免阻断对话）。
fn render_persona_vars(text: &str, vars: &[(&str, String)]) -> String {
    let mut rendered = text.to_owned();
    for (name, value) in vars {
        rendered = rendered.replace(&format!("{{{{{name}}}}}"), value);
    }
    rendered
}

fn today_string() -> String {
    crate::time::iso8601_utc(crate::time::now_millis())
        .chars()
        .take(10)
        .collect()
}

fn vault_display_name(workspace: &WorkspaceService) -> String {
    workspace
        .vault()
        .root()
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Vault".to_owned())
}

/// 运行环境事实块：每个专家都会带上，防止模型把自己说成别的厂商的模型。
/// 只陈述可核对的事实（应用名 + 本次模型标识），不评价模型能力。
fn runtime_guard(model: Option<&str>) -> String {
    let model_note = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("本次请求使用的模型标识是 `{value}`"))
        .unwrap_or_else(|| "具体模型标识以「设置 → AI 助手 → 模型」里显示的为准".to_owned());
    format!(
        "\n\n【运行环境】你在 Lattice（格物）桌面应用里作为 AI 助手运行，底层模型由用户配置，{model_note}。\
被问到「你是什么模型 / 哪家公司的产品」时，如实说明你是 Lattice 内的 AI 助手并给出上面的模型标识；\
不要自称是其他厂商的模型，也不要编造训练数据、参数或发布时间。"
    )
}

/// 解析专家为运行时策略。返回 None 表示「不注入」（无专家 / 专家不存在 /
/// 已停用），此时行为与 E1 之前完全一致。`model` 只用于运行环境事实块。
pub fn resolve(
    workspace: &WorkspaceService,
    expert_id: Option<&str>,
    model: Option<&str>,
) -> Option<ExpertRuntime> {
    let expert_id = expert_id?.trim();
    if expert_id.is_empty() {
        return None;
    }
    let document = workspace.expert_get(expert_id).ok()?;
    if document.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let string_at = |path: &str| {
        document
            .pointer(path)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let expert_name = string_at("/name");
    let expert_version = string_at("/version");
    let mut prompt_versions = vec![format!("expert:{expert_id}@{expert_version}")];

    // system 第一块：人格提示词（支持 {{today}} / {{vaultName}} 变量）。
    let persona = render_persona_vars(
        &string_at("/systemPrompt"),
        &[
            ("today", today_string()),
            ("vaultName", vault_display_name(workspace)),
        ],
    );
    let mut used = persona.chars().count();
    let mut system = persona;

    // 技能两种绑法（E2）：preload 正文全文注入；discoverable 只常驻目录、模型按需加载。
    let mut exposed_skills: Vec<SkillBrief> = Vec::new();
    if let Some(bindings) = document.get("skills").and_then(Value::as_array) {
        for binding in bindings {
            if binding.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let mode = binding.get("mode").and_then(Value::as_str).unwrap_or("preload");
            let skill_id = binding.get("id").and_then(Value::as_str).unwrap_or_default();
            if mode != "preload" {
                if let Ok(skill) = workspace.skill_get(skill_id) {
                    if skill.get("enabled").and_then(Value::as_bool) == Some(false) {
                        continue;
                    }
                    exposed_skills.push(SkillBrief {
                        id: skill_id.to_owned(),
                        title: skill
                            .get("title")
                            .and_then(Value::as_str)
                            .filter(|value| !value.trim().is_empty())
                            .or_else(|| skill.get("name").and_then(Value::as_str))
                            .unwrap_or(skill_id)
                            .to_owned(),
                        description: skill
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    });
                }
                continue;
            }
            let Ok(skill) = workspace.skill_get(skill_id) else {
                continue;
            };
            let content = skill
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            if content.is_empty() {
                continue;
            }
            let content: String = content.chars().take(EXPERT_SKILL_PRELOAD_MAX_CHARS).collect();
            let name = skill
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(skill_id);
            let version = skill.get("version").and_then(Value::as_str).unwrap_or("1.0.0");
            let block = format!("\n\n【技能：{name}（{skill_id}）】\n{content}");
            if used + block.chars().count() > EXPERT_SYSTEM_MAX_CHARS {
                log::warn!("专家 {expert_id} 的预载技能 {skill_id} 超出 system 预算，已跳过");
                continue;
            }
            used += block.chars().count();
            system.push_str(&block);
            prompt_versions.push(format!("skill:{skill_id}@{version}"));
        }
    }

    // L1 目录：只列 id/标题/说明，不含正文。
    if !exposed_skills.is_empty() {
        let catalog = build_skill_catalog(&exposed_skills);
        if used + catalog.chars().count() <= EXPERT_SYSTEM_MAX_CHARS {
            system.push_str(&catalog);
        }
    }
    // 运行环境事实块放最后：人格与技能方法在上、事实约束在下，避免被长正文淹没。
    let guard = runtime_guard(model);
    if used + guard.chars().count() <= EXPERT_SYSTEM_MAX_CHARS {
        system.push_str(&guard);
    }

    let mut capabilities = document
        .pointer("/capabilities/tools")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // 目录非空才有加载入口：没有可发现技能时工具面不出现 skill_load。
    if !exposed_skills.is_empty() && !capabilities.iter().any(|item| item == SKILL_LOAD_TOOL) {
        capabilities.push(SKILL_LOAD_TOOL.to_owned());
    }
    let scope_exclude = document
        .pointer("/capabilities/scopeExclude")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(normalize_scope_path)
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // E3：MCP 绑定写在 Frontmatter `mcp.servers`（也兼容平铺 `mcpServers`）。
    let mcp_servers = document
        .pointer("/mcp/servers")
        .or_else(|| document.get("mcpServers"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .take(crate::ai::core::mcp::MAX_SERVERS)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(ExpertRuntime {
        expert_id: expert_id.to_owned(),
        expert_name,
        system,
        prompt_versions,
        capabilities,
        write_policy: WritePolicy::parse(&string_at("/capabilities/writePolicy")),
        max_rounds: document
            .pointer("/capabilities/maxRounds")
            .and_then(Value::as_u64)
            .unwrap_or(6)
            .clamp(1, 12) as u32,
        scope_exclude,
        exposed_skills,
        mcp_servers,
    })
}

impl ExpertRuntime {
    /// 是否允许写（写工具面 + 内核调度两个闸门共用）。
    pub fn writes_allowed(&self) -> bool {
        self.write_policy.allows_writes()
    }

    /// E3：该 MCP Server 是否被专家绑定（key/name 均可，支持 `*`）。
    pub fn mcp_allows_server(&self, key: &str, name: &str) -> bool {
        self.mcp_servers.iter().any(|item| {
            item == "*"
                || item == name
                || crate::ai::core::mcp::slug(item) == crate::ai::core::mcp::slug(key)
        })
    }

    /// E3：该 `mcp__<server>__<tool>` 是否落在绑定范围内。
    pub fn mcp_allows_tool(&self, external_name: &str) -> bool {
        let Some(rest) = external_name.strip_prefix("mcp__") else {
            return false;
        };
        let Some((server, _)) = rest.split_once("__") else {
            return false;
        };
        self.mcp_servers
            .iter()
            .any(|item| item == "*" || crate::ai::core::mcp::slug(item) == server)
    }

    /// trace 用：system 首个非空行（≤160 字符）。正文全文不入库，只留可对照的摘要。
    pub fn system_preview(&self) -> String {
        self.system
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| line.chars().take(160).collect())
            .unwrap_or_default()
    }

    /// trace 用：system 文本指纹（FNV-1a 64 位，十六进制）。
    pub fn system_hash(&self) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in self.system.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{hash:016x}")
    }
}

/// 能力词表 → 具体工具名的放行判定。
/// 词表语义：read/search/write/mcp 四类（write 兼容旧动词 create/update/
/// delete/move/copy/archive）；显式写工具名也可直通；空表 = 默认只读检索。
/// 未匹配任何桶的未来工具默认拒绝（显式列出才放行）。
/// `write_policy=disabled` 时无论词表写了什么都剥夺写工具（策略只收紧不放宽）。
pub fn tool_allowed(name: &str, capabilities: &[String], write_policy: WritePolicy) -> bool {
    let has = |token: &str| capabilities.iter().any(|item| item == token);
    let write_verbs = [
        "write",
        "create",
        "update",
        "delete",
        "move",
        "copy",
        "archive",
    ];
    if name.starts_with("mcp__") {
        return has("mcp");
    }
    match name {
        "lattice_note_read" | "lattice_file_read" | "lattice_file_list" => {
            capabilities.is_empty() || has("read")
        }
        "lattice_note_search" | "lattice_file_grep" => capabilities.is_empty() || has("search"),
        "lattice_file_operation" => {
            write_policy.allows_writes() && write_verbs.iter().any(|verb| has(verb))
        }
        // skill_load（E2）等未来内置工具：显式列出才可用
        other => capabilities.iter().any(|item| item == other),
    }
}

/// 把专家策略写进请求：system 文本（协议层组装 system 消息）、工具面过滤、
/// 轮数收紧（写进 `budget.maxSteps`，`budget_with_overrides` 再钳一次）。
/// 续跑请求克隆自当前请求，策略随之继承；落盘侧 redact_request_secrets
/// 只保留白名单键，system 文本不会持久化。
pub fn apply(request: &mut Value, runtime: &ExpertRuntime) {
    // 请求载荷来自 IPC，理论上可能是任意 JSON；只有对象才谈得上注入。
    if !request.is_object() {
        return;
    }
    if !runtime.system.trim().is_empty() {
        request["system"] = Value::String(runtime.system.clone());
    }
    if let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) {
        tools.retain(|tool| {
            let Some(name) = tool.get("name").and_then(Value::as_str) else {
                return true;
            };
            // E3：MCP 工具面按 `mcp.servers` 绑定裁剪（未绑定 = 不可见）。
            if crate::ai::core::mcp::is_mcp_tool(name) {
                return runtime.mcp_allows_tool(name);
            }
            tool_allowed(name, &runtime.capabilities, runtime.write_policy)
        });
        // L2 加载入口由内核补进工具面：前端不知道专家绑了哪些可发现技能。
        if runtime.capabilities.iter().any(|item| item == SKILL_LOAD_TOOL)
            && !tools
                .iter()
                .any(|tool| tool.get("name").and_then(Value::as_str) == Some(SKILL_LOAD_TOOL))
        {
            tools.push(skill_load_tool_descriptor());
        }
    }
    // 轮数只收紧：已有预算取更小值；预算缺失或形态非法时按专家上限重写。
    let ceiling = u64::from(runtime.max_rounds);
    let steps = request
        .pointer("/budget/maxSteps")
        .and_then(Value::as_u64)
        .map(|value| value.min(ceiling))
        .unwrap_or(ceiling);
    match request.get_mut("budget") {
        Some(Value::Object(budget)) => {
            budget.insert("maxSteps".to_owned(), Value::from(steps));
        }
        _ => {
            request["budget"] = serde_json::json!({ "maxSteps": steps });
        }
    }
}

/// 从请求读 expertId 并解析（入队/直连两条入口共用）。
/// 返回 None 表示「不注入」——无 expertId、专家不存在或已停用，行为回到 E1 之前。
pub fn resolve_for_request(
    workspace: &WorkspaceService,
    request: &Value,
) -> Option<ExpertRuntime> {
    let expert_id = request
        .get("expertId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let model = request.pointer("/provider/model").and_then(Value::as_str);
    resolve(workspace, expert_id.as_deref(), model)
}

/// 解析并写进请求（system / 工具面 / 轮数）。幂等：重复调用不会叠加。
pub fn apply_request(workspace: &WorkspaceService, request: &mut Value) -> Option<ExpertRuntime> {
    let runtime = resolve_for_request(workspace, request)?;
    apply(request, &runtime);
    Some(runtime)
}

fn requested_skill_ids(request: &Value) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    request
        .get("invokedSkills")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty() && id.chars().count() <= 120)
                .filter(|id| seen.insert((*id).to_owned()))
                .take(INVOKED_SKILLS_MAX_COUNT)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn skill_display_name(skill: &Value, fallback: &str) -> String {
    skill
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| skill.get("name").and_then(Value::as_str))
        .unwrap_or(fallback)
        .to_owned()
}

/// 用户从 `/` 面板显式调用的技能：把 SKILL.md 正文追加进本次 run 的 system。
/// 与模型侧的 `skill_load` 相互独立——不依赖专家绑定，也不改变工具面。
/// 返回实际注入的技能 id；重复调用靠正文标记判重，不会叠加。
pub fn apply_invoked_skills(workspace: &WorkspaceService, request: &mut Value) -> Vec<String> {
    if !request.is_object() {
        return Vec::new();
    }
    let ids = requested_skill_ids(request);
    if ids.is_empty() {
        return Vec::new();
    }
    let mut system = request
        .get("system")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default();
    if system.trim().is_empty() {
        let model = request.pointer("/provider/model").and_then(Value::as_str);
        system = runtime_guard(model);
    }
    let mut used = system.chars().count();
    let mut applied = Vec::new();
    for id in ids {
        let Ok(skill) = workspace.skill_get(&id) else {
            log::warn!("显式调用的技能不存在，已忽略：{id}");
            continue;
        };
        if skill.get("enabled").and_then(Value::as_bool) == Some(false) {
            log::warn!("显式调用的技能已停用，已忽略：{id}");
            continue;
        }
        let name = skill_display_name(&skill, &id);
        let marker = format!("【已调用技能：{name}（{id}）】");
        if system.contains(&marker) {
            continue;
        }
        let content = skill
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if content.is_empty() {
            continue;
        }
        let content: String = content.chars().take(INVOKED_SKILL_MAX_CHARS).collect();
        let block = format!("\n\n{marker}\n{content}");
        if used + block.chars().count() > INVOKED_SKILLS_MAX_CHARS {
            log::warn!("显式技能 {id} 超出本次 system 预算，已跳过");
            continue;
        }
        used += block.chars().count();
        system.push_str(&block);
        applied.push(id);
    }
    if !applied.is_empty() {
        request["system"] = Value::String(system.trim_start().to_owned());
    }
    applied
}

/// run 事件 `skills_invoked`：记录用户显式调用了哪些技能（只留 id/标题/版本，
/// 正文已在 system 里，不再落库）。
pub fn invoked_event(workspace: &WorkspaceService, request: &Value) -> Option<Value> {
    let skills: Vec<Value> = requested_skill_ids(request)
        .into_iter()
        .filter_map(|id| {
            let skill = workspace.skill_get(&id).ok()?;
            if skill.get("enabled").and_then(Value::as_bool) == Some(false) {
                return None;
            }
            Some(serde_json::json!({
                "id": id,
                "title": skill_display_name(&skill, &id),
                "version": skill.get("version").and_then(Value::as_str).unwrap_or("1.0.0"),
            }))
        })
        .collect();
    if skills.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "type": "skills_invoked",
        "count": skills.len(),
        "skills": skills,
    }))
}

/// run 事件 `expert_loaded`：把「哪个专家、什么版本、注入了多少内容」写进
/// run 事件流（前端时间线与 ai_run_events 回放都能看到）。
/// 正文不入库，只留首行预览 + 指纹 + 字符数——需要全文看 `.lattice/experts/<id>.md`。
pub fn loaded_event(runtime: &ExpertRuntime) -> Value {
    let skills: Vec<Value> = runtime
        .prompt_versions
        .iter()
        .filter_map(|entry| entry.strip_prefix("skill:"))
        .map(|entry| {
            let (id, version) = entry.split_once('@').unwrap_or((entry, ""));
            serde_json::json!({ "id": id, "version": version })
        })
        .collect();
    let skill_versions: Vec<&str> = runtime
        .prompt_versions
        .iter()
        .filter(|entry| entry.starts_with("skill:"))
        .map(String::as_str)
        .collect();
    // 溯源摘要只给 trace 看，不进对话：`type` 是独立事件类型而不是 `status`，
    // 前端不会把它渲染成一条可见消息。E1 首版误用 status，用户看到「专家…已加载」
    // 以为专家/技能被自动调用了——实际那是「当前设置已生效」，不是一次工具调用。
    let summary: String = format!(
        "专家「{}」{} · {} 份技能{}",
        runtime.expert_name,
        runtime.prompt_versions.first().map(String::as_str).unwrap_or("未标版本"),
        skill_versions.len(),
        if skill_versions.is_empty() { String::new() } else { format!("（{}）", skill_versions.join(" ")) },
    )
    .chars()
    .take(200)
    .collect();
    serde_json::json!({
        "type": "expert_loaded",
        "summary": summary,
        "expert": {
            "id": runtime.expert_id,
            "name": runtime.expert_name,
            "promptVersions": runtime.prompt_versions,
            "skills": skills,
            "capabilities": runtime.capabilities,
            "discoverableSkills": runtime
                .exposed_skills
                .iter()
                .map(|skill| serde_json::json!({ "id": skill.id, "title": skill.title }))
                .collect::<Vec<_>>(),
            "writePolicy": runtime.write_policy.as_str(),
            "maxRounds": runtime.max_rounds,
            "systemChars": runtime.system.chars().count(),
            "systemHash": runtime.system_hash(),
            "systemPreview": runtime.system_preview(),
        }
    })
}

/// 技能目录块（L1）：每条 ≤`EXPERT_SKILL_CATALOG_ENTRY_MAX_CHARS`，整块
/// ≤`EXPERT_SKILL_CATALOG_MAX_CHARS`；超预算的条目整条跳过（宁可少列，不截半句）。
pub(crate) fn build_skill_catalog(exposed: &[SkillBrief]) -> String {
    if exposed.is_empty() {
        return String::new();
    }
    let mut catalog = String::from("\n\n【可用技能】需要时调用 skill_load（参数 id）读取完整方法：");
    for brief in exposed {
        let description: String = brief
            .description
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(EXPERT_SKILL_CATALOG_ENTRY_MAX_CHARS)
            .collect();
        let entry = format!("\n- {}（{}）：{}", brief.title, brief.id, description);
        if catalog.chars().count() + entry.chars().count() > EXPERT_SKILL_CATALOG_MAX_CHARS {
            log::warn!("技能目录超出预算（{}），剩余条目已跳过", brief.id);
            break;
        }
        catalog.push_str(&entry);
    }
    catalog
}

/// `skill_load` 的工具描述（provider 中立形状，协议层再转 function 形状）。
fn skill_load_tool_descriptor() -> Value {
    serde_json::json!({
        "name": SKILL_LOAD_TOOL,
        "kind": "read",
        "description": "加载某个技能的完整方法正文。参数 id 取 system 里「可用技能」目录中的括号值；返回有界文本，已加载过的技能不必重复加载。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "技能 id，例如 vault-search" }
            },
            "required": ["id"]
        }
    })
}

/// 路径规范化：反斜杠统一、去掉开头的 `./` 与 `/`。
/// 写调用越界的判定放在 `agent::runner`（唯一决策点），这里只提供规范化。
pub(crate) fn normalize_scope_path(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::{ExpertRuntime, WritePolicy, normalize_scope_path, render_persona_vars, tool_allowed};
    use serde_json::json;

    fn runtime(capabilities: &[&str], scope_exclude: &[&str], write_policy: WritePolicy) -> ExpertRuntime {
        ExpertRuntime {
            expert_id: "test".into(),
            expert_name: "测试".into(),
            system: String::new(),
            prompt_versions: vec![],
            capabilities: capabilities.iter().map(|item| item.to_string()).collect(),
            write_policy,
            max_rounds: 6,
            scope_exclude: scope_exclude.iter().map(|item| item.to_string()).collect(),
            exposed_skills: Vec::new(),
            mcp_servers: Vec::new(),
        }
    }

    #[test]
    fn capability_vocab_maps_to_tool_names() {
        let read_only = runtime(&["read", "search"], &[], WritePolicy::Confirm);
        assert!(tool_allowed("lattice_note_read", &read_only.capabilities, read_only.write_policy));
        assert!(tool_allowed("lattice_note_search", &read_only.capabilities, read_only.write_policy));
        assert!(!tool_allowed("lattice_file_operation", &read_only.capabilities, read_only.write_policy));
        assert!(!tool_allowed("mcp__x__y", &read_only.capabilities, read_only.write_policy));

        // 旧写动词兼容：archive/move 等价于 write
        let legacy = runtime(&["read", "search", "archive"], &[], WritePolicy::Confirm);
        assert!(tool_allowed("lattice_file_operation", &legacy.capabilities, legacy.write_policy));

        let empty = runtime(&[], &[], WritePolicy::Confirm);
        assert!(tool_allowed("lattice_note_read", &empty.capabilities, empty.write_policy));
        assert!(!tool_allowed("lattice_file_operation", &empty.capabilities, empty.write_policy));

        let mcp = runtime(&["read", "mcp"], &[], WritePolicy::Confirm);
        assert!(tool_allowed("mcp__notion__create_event", &mcp.capabilities, mcp.write_policy));
        assert!(!tool_allowed("lattice_file_operation", &mcp.capabilities, mcp.write_policy));

        // 未来内置工具默认拒绝，显式列出才放行
        let explicit = runtime(&["read", "skill_load"], &[], WritePolicy::Confirm);
        assert!(tool_allowed("skill_load", &explicit.capabilities, explicit.write_policy));
        assert!(!tool_allowed("skill_load", &empty.capabilities, empty.write_policy));

        // disabled 是硬剥夺：词表写了 write 也不给写工具
        let locked = runtime(&["read", "write"], &[], WritePolicy::Disabled);
        assert!(!tool_allowed("lattice_file_operation", &locked.capabilities, locked.write_policy));
        assert!(!locked.writes_allowed());
        assert!(!WritePolicy::Disabled.auto_approves_l2());
        assert!(WritePolicy::Auto.auto_approves_l2());
    }

    #[test]
    fn apply_sets_system_filters_tools_and_tightens_budget() {
        let mut expert = runtime(&["read", "search"], &[], WritePolicy::Confirm);
        expert.system = "你是测试专家".into();
        expert.max_rounds = 4;
        let mut request = json!({
            "message": "hi",
            "budget": { "maxSteps": 12, "maxToolCalls": 24 },
            "tools": [
                { "name": "lattice_note_search", "inputSchema": {} },
                { "name": "lattice_file_operation", "inputSchema": {} },
                { "name": "lattice_note_read", "inputSchema": {} },
            ],
        });
        super::apply(&mut request, &expert);
        assert_eq!(request["system"], json!("你是测试专家"));
        let names: Vec<&str> = request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["lattice_note_search", "lattice_note_read"]);
        // 轮数只收紧：12 → 4；未涉及的字段原样保留
        assert_eq!(request["budget"]["maxSteps"], json!(4));
        assert_eq!(request["budget"]["maxToolCalls"], json!(24));

        // 已比上限更紧的预算不被放大
        let mut tighter = json!({ "budget": { "maxSteps": 2 } });
        super::apply(&mut tighter, &expert);
        assert_eq!(tighter["budget"]["maxSteps"], json!(2));

        // 非对象请求 / 非法预算形态不 panic：前者原样返回，后者按专家上限重写
        let mut scalar = json!("不是对象");
        super::apply(&mut scalar, &expert);
        assert_eq!(scalar, json!("不是对象"));
        let mut broken = json!({ "budget": "oops" });
        super::apply(&mut broken, &expert);
        assert_eq!(broken["budget"]["maxSteps"], json!(4));
    }

    #[test]
    fn persona_vars_replace_known_only() {
        let rendered = render_persona_vars(
            "今天是 {{today}}，库：{{vaultName}}，未知 {{keep}}",
            &[("today", "2026-10-26".into()), ("vaultName", "我的库".into())],
        );
        assert!(rendered.contains("2026-10-26"));
        assert!(rendered.contains("我的库"));
        assert!(rendered.contains("{{keep}}"));
    }

    #[test]
    fn system_digest_is_stable_and_preview_is_first_line() {
        let mut expert = runtime(&["read"], &[], WritePolicy::Confirm);
        expert.system = "\n  你是任务执行专家。\n第二段不应出现在预览里。".into();
        assert_eq!(expert.system_preview(), "你是任务执行专家。");
        assert_eq!(expert.system_hash().len(), 16);
        let digest = expert.system_hash();
        expert.system.push('x');
        assert_ne!(digest, expert.system_hash());
    }

    #[test]
    fn skill_catalog_stays_within_budget() {
        let briefs: Vec<super::SkillBrief> = (0..40)
            .map(|index| super::SkillBrief {
                id: format!("skill-{index}"),
                title: format!("技能 {index}"),
                description: "很长的说明".repeat(120),
            })
            .collect();
        let catalog = super::build_skill_catalog(&briefs);
        assert!(
            catalog.chars().count() <= super::EXPERT_SKILL_CATALOG_MAX_CHARS,
            "目录总长必须受控：{}",
            catalog.chars().count()
        );
        // 每条仍然完整（不出现被截断的半个 id / 半句话）
        for line in catalog.lines().filter(|line| line.starts_with("- ")) {
            assert!(line.chars().count() <= super::EXPERT_SKILL_CATALOG_ENTRY_MAX_CHARS + 40);
            assert!(!line.ends_with('…'));
        }
        assert!(catalog.contains("skill-0"));

        // 空列表不产生目录块（没有可发现技能就没有 L1）
        assert!(!super::build_skill_catalog(&[]).contains("可用技能"));
    }

    #[test]
    fn apply_adds_skill_load_tool_only_when_catalog_exists() {
        let mut with_skill = runtime(&["read", "search", "skill_load"], &[], WritePolicy::Confirm);
        with_skill.exposed_skills = vec![super::SkillBrief {
            id: "vault-search".into(),
            title: "知识库检索".into(),
            description: "找证据".into(),
        }];
        let mut request = json!({ "tools": [ { "name": "lattice_note_read", "inputSchema": {} } ] });
        super::apply(&mut request, &with_skill);
        let names: Vec<&str> = request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"skill_load"));
        let descriptor = request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == json!("skill_load"))
            .unwrap();
        assert!(descriptor["inputSchema"].is_object(), "协议层要求对象 schema");
        assert!(descriptor["description"].as_str().unwrap().contains("完整方法"));

        // 重复 apply 不叠加
        super::apply(&mut request, &with_skill);
        let count = request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|tool| tool["name"] == json!("skill_load"))
            .count();
        assert_eq!(count, 1);

        // 没有可发现技能时不注入入口
        let mut plain = runtime(&["read"], &[], WritePolicy::Confirm);
        plain.exposed_skills.clear();
        let mut request = json!({ "tools": [ { "name": "lattice_note_read", "inputSchema": {} } ] });
        super::apply(&mut request, &plain);
        assert!(
            request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .all(|tool| tool["name"] != json!("skill_load"))
        );
    }

    #[test]
    fn loaded_event_is_trace_only_and_carries_versions() {
        let mut expert = runtime(&["read", "skill_load"], &[], WritePolicy::Confirm);
        expert.prompt_versions = vec![
            "expert:task-executor@2.0.0".into(),
            "skill:vault-search@2.0.0".into(),
        ];
        let event = super::loaded_event(&expert);
        // 关键回归：不能再是 status，否则前端会渲染成一条「专家已加载」的对话状态行，
        // 用户会以为专家/技能被自动调用了（专家的注入是设置生效，不是工具调用）。
        assert_eq!(event["type"], serde_json::json!("expert_loaded"));
        assert!(event.get("status").is_none());
        assert!(event.get("text").is_none());
        assert!(event["summary"].as_str().unwrap().contains("task-executor"));
        assert_eq!(event["expert"]["promptVersions"][0], serde_json::json!("expert:task-executor@2.0.0"));
    }

    #[test]
    fn runtime_guard_states_the_actual_model() {
        let with_model = super::runtime_guard(Some("deepseek-flash"));
        assert!(with_model.contains("Lattice"));
        assert!(with_model.contains("deepseek-flash"));
        assert!(with_model.contains("不要自称是其他厂商的模型"));

        let without = super::runtime_guard(None);
        assert!(without.contains("设置"));
    }

    #[test]
    fn scope_paths_are_normalized_for_prefix_matching() {
        assert_eq!(normalize_scope_path("\\.lattice\\x"), ".lattice/x");
        assert_eq!(normalize_scope_path("./_templates/a.md"), "_templates/a.md");
        assert_eq!(normalize_scope_path("  /a/b  "), "a/b");
    }

    #[test]
    fn invoked_skills_inject_without_expert_and_stay_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let service =
            crate::workspace::WorkspaceService::open(directory.path().into()).unwrap();
        let skill_dir = directory.path().join(".lattice/skills/note-format");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: note-format\ndescription: 整理笔记结构\nmetadata:\n  lattice.title: 笔记格式\n---\n先给结论，再给证据。\n",
        )
        .unwrap();

        let mut request = serde_json::json!({
            "invokedSkills": ["note-format", "missing-skill", "note-format"],
            "provider": { "model": "test-model" },
        });
        let applied = super::apply_invoked_skills(&service, &mut request);
        assert_eq!(applied, vec!["note-format"], "未知技能被忽略、重复 id 去重");
        let system = request["system"].as_str().unwrap();
        assert!(system.contains("【已调用技能：笔记格式（note-format）】"));
        assert!(system.contains("先给结论，再给证据。"));
        assert!(system.contains("test-model"), "无专家时仍带运行环境事实块");

        // 重复应用不叠加（续跑/恢复会重复走注入路径）。
        assert!(super::apply_invoked_skills(&service, &mut request).is_empty());
        let system = request["system"].as_str().unwrap();
        assert_eq!(system.matches("【已调用技能：").count(), 1);

        let event = super::invoked_event(&service, &request).unwrap();
        assert_eq!(event["type"], serde_json::json!("skills_invoked"));
        assert_eq!(event["count"], serde_json::json!(1));
        assert_eq!(event["skills"][0]["id"], serde_json::json!("note-format"));
    }

    #[test]
    fn invoked_skills_skip_disabled_skills() {
        let directory = tempfile::tempdir().unwrap();
        let service =
            crate::workspace::WorkspaceService::open(directory.path().into()).unwrap();
        let skill_dir = directory.path().join(".lattice/skills/off-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: off-skill\ndescription: 已停用\nmetadata:\n  lattice.title: 停用技能\n  lattice.enabled: false\n---\n不应被注入。\n",
        )
        .unwrap();

        let mut request = serde_json::json!({ "invokedSkills": ["off-skill"] });
        assert!(super::apply_invoked_skills(&service, &mut request).is_empty());
        assert!(request.get("system").is_none());
    }
}
