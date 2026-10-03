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
  };
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
