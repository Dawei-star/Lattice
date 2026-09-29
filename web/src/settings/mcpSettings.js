const STORAGE_KEY = 'lattice-mcp-settings-v1';

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
  };
}
