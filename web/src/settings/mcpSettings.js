const STORAGE_KEY = 'lattice-mcp-settings-v1';

/** 内置 Lattice MCP Server 中属于「写入」的工具：默认不注册，需显式开启开关。 */
export const MCP_WRITE_TOOL_NAMES = Object.freeze(['create_note', 'update_note', 'restore_note_version']);

/**
 * 列表改动前先取基线：`settings.servers` 还没落盘时（`/api/mcp/info` 仍在返回或读取失败），
 * 界面展示的是回退出来的内置 Lattice Server，此时直接操作空数组会让「开关点了没反应」、
 * 或把内置条目从列表里弄丢。所有增删改都必须走这里取基线。
 */
export function withVisibleServers(currentServers, fallbackServers, updater) {
  const base = Array.isArray(currentServers) && currentServers.length ? currentServers : (fallbackServers ?? []);
  return updater(base);
}

export const DEFAULT_MCP_SETTINGS = Object.freeze({
  projectEnabled: false,
  servers: [],
});

export function loadMcpSettings() {
  if (typeof localStorage === 'undefined') return cloneDefaults();
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return cloneDefaults();
  }
}

export function saveMcpSettings(value) {
  const next = normalize(value);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 本地设置不可写时，当前页面仍然保留本次状态。
  }
  return next;
}

export function createMcpServer(overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return normalizeServer({
    id: 'mcp-' + Date.now() + '-' + suffix,
    key: 'server-' + Date.now() + '-' + suffix,
    name: '新 MCP Server',
    description: '自定义 MCP Server',
    command: 'node',
    args: [],
    env: {},
    transport: 'stdio',
    enabled: true,
    builtin: false,
    ...overrides,
  });
}

function cloneDefaults() {
  return { projectEnabled: DEFAULT_MCP_SETTINGS.projectEnabled, servers: [] };
}

function normalize(value) {
  const servers = Array.isArray(value?.servers) ? value.servers.map(normalizeServer).filter(Boolean) : [];
  return {
    projectEnabled: value?.projectEnabled === true,
    servers,
  };
}

function normalizeServer(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : 'mcp-' + Date.now();
  const key = typeof value.key === 'string' && value.key.trim() ? value.key.trim() : id;
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : '未命名 MCP Server';
  const args = Array.isArray(value.args) ? value.args.filter((item) => typeof item === 'string') : [];
  const env = value.env && typeof value.env === 'object' && !Array.isArray(value.env)
    ? Object.fromEntries(Object.entries(value.env).filter(([key, item]) => typeof key === 'string' && typeof item === 'string'))
    : {};
  return {
    id,
    key,
    name,
    description: typeof value.description === 'string' ? value.description : '',
    command: typeof value.command === 'string' && value.command.trim() ? value.command.trim() : 'node',
    args,
    env,
    url: typeof value.url === 'string' ? value.url.trim() : '',
    transport: value.transport === 'sse' ? 'sse' : 'stdio',
    enabled: value.enabled !== false,
    builtin: value.builtin === true,
    tools: Array.isArray(value.tools) ? value.tools : [],
    // 市场条目带来的「必须补齐的密钥」清单：让编辑器能按变量名给出独立输入框，
    // 而不是把用户丢回一整块 JSON。来自配置文件导入的 Server 没有这份信息。
    requiresEnv: normalizeRequiredEnv(value.requiresEnv),
    // 「必须补齐的启动参数」清单（例如 Git server 的仓库路径）
    requiresArgs: normalizeRequiredArgs(value.requiresArgs),
    // 用户为上面这些参数填的值：args 里保留 {token} 模板，导出时再物化
    argValues: normalizeArgValues(value.argValues),
  };
}

function normalizeArgValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => typeof key === 'string' && key.trim() && typeof item === 'string' && item.trim())
    .map(([key, item]) => [key.trim(), item.trim()]));
}

function normalizeRequiredArgs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const items = [];
  for (const item of value) {
    const token = typeof item?.token === 'string' ? item.token.trim() : '';
    if (!token || seen.has(token)) continue;
    seen.add(token);
    items.push({
      token,
      label: typeof item?.label === 'string' && item.label.trim() ? item.label.trim() : token,
      hint: typeof item?.hint === 'string' ? item.hint.trim() : '',
      // 应用内已知的取值来源（知识库目录 / 数据库路径），用来给「一键填入」按钮
      preset: item?.preset === 'vaultDir' || item?.preset === 'dbFile' ? item.preset : '',
    });
  }
  return items;
}

/** args 里还没被替换掉的 {token} 占位符（顺序保留）。 */
export function pendingArgTokens(args) {
  return (Array.isArray(args) ? args : [])
    .map((arg) => /^\{(\w+)\}$/.exec(String(arg)))
    .filter(Boolean)
    .map((match) => match[1]);
}

/** 把内部 server 列表转回 .lattice/mcp.json 的磁盘形态（设置页项目级 JSON 编辑器用） */
export function serversToProjectDocument(servers) {
  const map = {};
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server?.key) continue;
    const transport = server.transport === 'sse' ? 'sse' : 'stdio';
    // 缺连接信息的残缺条目不落盘（与 collectActiveMcpServers 的口径一致）
    if (transport === 'sse' && !String(server.url ?? '').trim()) continue;
    if (transport === 'stdio' && !String(server.command ?? '').trim()) continue;
    map[server.key] = {
      name: server.name ?? server.key,
      description: server.description ?? '',
      transport,
      ...(transport === 'sse'
        ? { url: server.url ?? '' }
        : { command: server.command ?? '', args: Array.isArray(server.args) ? server.args : [] }),
      env: server.env && typeof server.env === 'object' ? server.env : {},
      enabled: server.enabled !== false,
    };
  }
  return { mcpServers: map };
}

/**
 * 合并用户级与项目级 MCP Server（用于 AI 聊天请求）：key 相同时用户级优先——
 * 与「用户级配置覆盖项目级」的通用约定一致；总量仍受 8 个上限约束（用户级先占位）。
 * 传给后端前会裁掉界面专用字段（tools / requiresEnv 等），只留连接所需的最小集。
 */
export function mergeProjectServers(userServers, projectServers) {
  const picked = [];
  const seen = new Set();
  for (const server of [...(Array.isArray(userServers) ? userServers : []), ...(Array.isArray(projectServers) ? projectServers : [])]) {
    if (!server || typeof server !== 'object' || !server.key || seen.has(server.key)) continue;
    // 停用/内置条目不参与；配置完整性由上游（collectActiveMcpServers / 后端归一化）保证
    if (server.enabled === false || server.builtin === true) continue;
    seen.add(server.key);
    picked.push({
      key: server.key,
      name: server.name,
      transport: server.transport,
      ...(server.transport === 'sse'
        ? { url: server.url }
        : { command: server.command, args: server.args }),
      env: server.env,
    });
    if (picked.length >= 8) break;
  }
  return picked;
}

/**
 * 挑出「配置完整且已启用」的外部 MCP Server，随 AI 聊天请求发给后端拉起，
 * 让应用内助手能调用这些工具（与导出配置给外部客户端的口径一致）。
 *
 * 内置 Lattice Server 不带：助手对知识库的原生工具（检索/读取/写操作）与之完全重叠，
 * 没有必要再拉起一个进程走一遍同样的能力。
 * args 里仍有未填占位符、缺启动命令或缺 URL 的条目直接跳过——
 * 「还没配好」的 Server 既不该导出，也不该被助手拉起。
 */
export function collectActiveMcpServers(settings = null) {
  const source = settings ?? loadMcpSettings();
  const servers = Array.isArray(source?.servers) ? source.servers : [];
  const out = [];
  for (const server of servers) {
    if (!server || server.enabled === false || server.builtin === true) continue;
    const args = resolveServerArgs(server.args, server.argValues);
    if (server.transport === 'sse') {
      if (/^https?:\/\//i.test(String(server.url ?? ''))) {
        out.push({ key: server.key, name: server.name, transport: 'sse', url: server.url, env: server.env ?? {} });
      }
      continue;
    }
    if (!server.command || pendingArgTokens(args).length) continue;
    out.push({
      key: server.key,
      name: server.name,
      transport: 'stdio',
      command: server.command,
      args,
      env: server.env ?? {},
    });
  }
  return out.slice(0, 8);
}

/**
 * 把 args 模板里的 {token} 替换成用户填的值。
 * 没填的（或空串）保留占位符本身，好让「还没配好」这件事一直可见，
 * 也保证导出的配置不会退化成相对路径 `.` 这种在客户端手里毫无意义的值。
 */
export function resolveServerArgs(args, argValues) {
  const values = argValues && typeof argValues === 'object' ? argValues : {};
  return (Array.isArray(args) ? args : []).map((arg) => {
    const match = /^\{(\w+)\}$/.exec(String(arg));
    if (!match) return arg;
    const value = values[match[1]];
    return typeof value === 'string' && value.trim() ? value.trim() : arg;
  });
}

/** 写回一个参数值；空值即删除该项，返回新的 argValues（不修改入参）。 */
export function setArgValue(argValues, token, value) {
  const next = { ...(argValues && typeof argValues === 'object' ? argValues : {}) };
  const trimmed = String(value ?? '').trim();
  if (trimmed) next[token] = trimmed;
  else delete next[token];
  return next;
}

function normalizeRequiredEnv(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const items = [];
  for (const item of value) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    items.push({
      name,
      hint: typeof item?.hint === 'string' ? item.hint.trim() : '',
    });
  }
  return items;
}

/**
 * 从编辑器的环境变量 JSON 文本里取一个变量的值。
 * 文本尚未成为合法对象时返回空串，避免边输入边抛错。
 */
export function readEnvValue(envText, name) {
  try {
    const parsed = JSON.parse(envText || '{}');
    const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed[name] : undefined;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * 把某个变量的值写回环境变量 JSON 文本，保留其它键的原有顺序。
 * 文本不是合法对象时原样返回，让用户先修好 JSON（并看到编辑器的报错）。
 */
export function writeEnvValue(envText, name, value) {
  let parsed;
  try {
    parsed = JSON.parse(envText || '{}');
  } catch {
    return envText;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return envText;
  const next = { ...parsed };
  // 密钥输入框里粘贴常带首尾空白/换行，原样写进去会让客户端拿到一个连不上的 Key
  const trimmed = String(value ?? '').trim();
  if (trimmed) next[name] = trimmed;
  else delete next[name];
  return JSON.stringify(next, null, 2);
}
