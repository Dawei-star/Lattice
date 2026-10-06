/**
 * AI 助手的 MCP 客户端集成。
 *
 * 用户在设置页启用的 MCP Server 随聊天请求（mcpServers 字段）传到后端；
 * 这里负责把它们拉起/连接、列出工具、执行模型发起的 mcp 动作。
 * 协议是 Lattice 自己的文本协议（lattice-actions 围栏），不依赖上游模型的原生
 * function calling —— 与 read/search 动作同一套循环，任何模型都能用。
 *
 * 生命周期：同一身份（command/args/env/url 完全一致）的 Server 在模块级缓存里复用，
 * 空闲一段时间后自动关闭子进程；每次对话结束调用 release() 归还引用。
 * 单个 Server 连接失败不影响整体：失败项在 status 里如实上报，工具清单只含可用项。
 *
 * 安全边界：mcpServers 来自已通过 authenticateAi 的客户端（本地应用，用户自己配置），
 * 等同于用户亲手在终端启动这些进程；这里只做形状校验与数量/长度上限，不做白名单。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const MAX_SERVERS = 8;
const MAX_TOOL_SCHEMA_CHARS = 600;
const LIST_TOOLS_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 90_000;
// 空闲回收：对话之间往往有思考/阅读间隔，5 分钟足够覆盖一轮多轮对话
const IDLE_CLOSE_MS = 5 * 60_000;

// ── 模块级连接缓存 ───────────────────────────────────────────────────
// key = 身份指纹（transport+command+args+env+url）；同一配置只拉起一个进程
const connections = new Map();

function identityKey(server) {
  const sortedEnv = Object.fromEntries(Object.entries(server.env ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify([server.transport, server.command ?? '', server.args ?? [], sortedEnv, server.url ?? '']);
}

function makeClientName() {
  return 'lattice-ai';
}

async function openConnection(server) {
  const client = new Client({ name: makeClientName(), version: '0.1.0' });
  const timeout = setTimeout(() => {
    void client.close().catch(() => {});
  }, LIST_TOOLS_TIMEOUT_MS + 10_000);
  try {
    if (server.transport === 'sse') {
      const url = new URL(server.url);
      // 优先 Streamable HTTP（当前主流），404/协议不识别时回退旧 SSE 端点
      try {
        await client.connect(new StreamableHTTPClientTransport(url));
      } catch (streamableError) {
        await client.connect(new SSEClientTransport(url)).catch(() => {
          throw streamableError;
        });
      }
    } else {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
        stderr: 'pipe',
      });
      await client.connect(transport);
    }
    return client;
  } catch (error) {
    clearTimeout(timeout);
    await client.close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureConnection(server) {
  const key = identityKey(server);
  const existing = connections.get(key);
  if (existing) {
    clearTimeout(existing.idleTimer);
    existing.idleTimer = null;
    existing.refCount += 1;
    return existing;
  }
  const client = await openConnection(server);
  const entry = { client, server, refCount: 1, idleTimer: null, tools: [] };
  connections.set(key, entry);
  return entry;
}

function scheduleIdleClose(entry, key) {
  entry.idleTimer = setTimeout(() => {
    connections.delete(key);
    void entry.client.close().catch(() => {});
  }, IDLE_CLOSE_MS);
  entry.idleTimer.unref?.();
}

// ── 对外接口 ─────────────────────────────────────────────────────────

/** 形状校验 + 上限收敛；非法条目（缺命令/URL、协议不对）直接丢弃。 */
export function sanitizeMcpServers(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input.slice(0, MAX_SERVERS)) {
    if (!raw || typeof raw !== 'object') continue;
    const key = String(raw.key ?? '').trim().slice(0, 80);
    if (!key || seen.has(key)) continue;
    const transport = raw.transport === 'sse' ? 'sse' : 'stdio';
    const server = {
      key,
      name: String(raw.name ?? key).slice(0, 120),
      transport,
      command: transport === 'stdio' ? String(raw.command ?? '').trim().slice(0, 2048) : '',
      args: transport === 'stdio'
        ? (Array.isArray(raw.args) ? raw.args.map((item) => String(item).slice(0, 4096)).slice(0, 64) : [])
        : [],
      env: sanitizeEnv(raw.env),
      url: transport === 'sse' ? String(raw.url ?? '').trim().slice(0, 2048) : '',
    };
    if (transport === 'stdio' && !server.command) continue;
    if (transport === 'sse' && !/^https?:\/\//i.test(server.url)) continue;
    seen.add(key);
    out.push(server);
  }
  return out;
}

function sanitizeEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, item]) => typeof name === 'string' && name && typeof item === 'string')
      .slice(0, 64)
      .map(([name, item]) => [name.slice(0, 200), item.slice(0, 4096)]),
  );
}

/**
 * 打开一批 MCP Server 并列出工具。永不抛出：连接失败的 Server 记入 status，
 * 不阻塞对话（模型拿到的工具清单里没有它们，等于这次对话不可用）。
 *
 * @returns {{ servers: Array, tools: Array, status: Array, call: Function, release: Function }}
 *   tools: [{ server, name, description, inputSchema }]
 *   status: [{ key, name, ok, error? }]
 */
export async function createMcpRegistry(inputServers) {
  const servers = sanitizeMcpServers(inputServers);
  const opened = [];
  const status = [];
  for (const server of servers) {
    let entry = null;
    try {
      entry = await ensureConnection(server);
      if (!entry.tools.length) {
        const listed = await entry.client.listTools({}, { timeout: LIST_TOOLS_TIMEOUT_MS });
        entry.tools = Array.isArray(listed?.tools) ? listed.tools : [];
      }
      opened.push({ server, entry });
      status.push({ key: server.key, name: server.name, ok: true, toolCount: entry.tools.length });
    } catch (error) {
      // 连接成功但 listTools 失败时，这条引用没人归还（release 只遍历 opened）：
      // 必须在这里归还引用，减到 0 时直接关掉，否则子进程与引用计数永久泄漏，
      // 空闲回收也永远不会触发。
      if (entry) {
        entry.refCount -= 1;
        if (entry.refCount <= 0) {
          connections.delete(identityKey(server));
          clearTimeout(entry.idleTimer);
          void entry.client.close().catch(() => {});
        }
      }
      status.push({
        key: server.key,
        name: server.name,
        ok: false,
        error: String(error?.message ?? error).slice(0, 300),
      });
    }
  }

  const tools = opened.flatMap(({ server, entry }) => entry.tools.map((tool) => ({
    server: server.key,
    name: String(tool.name ?? '').slice(0, 120),
    description: String(tool.description ?? '').slice(0, 400),
    inputSchema: tool.inputSchema ?? { type: 'object' },
  })));

  return {
    servers: opened.map(({ server }) => server),
    tools,
    status,
    isEmpty: tools.length === 0,
    /** 执行一个 { type:'mcp', server, tool, args } 动作；结果统一为 { ok, text, error } */
    call: (action) => callTool(opened, action),
    release() {
      for (const { entry } of opened) {
        entry.refCount -= 1;
        if (entry.refCount <= 0 && !entry.idleTimer) {
          scheduleIdleClose(entry, identityKey(entry.server));
        }
      }
    },
  };
}

async function callTool(opened, action) {
  const serverKey = String(action?.server ?? '').trim();
  const toolName = String(action?.tool ?? '').trim();
  if (!serverKey || !toolName) {
    return { ok: false, text: '', error: 'mcp 动作缺少 server 或 tool 字段' };
  }
  const match = opened.find(({ server }) => server.key === serverKey);
  if (!match) {
    return { ok: false, text: '', error: `没有名为「${serverKey}」的可用 MCP Server（未配置或本次连接失败）` };
  }
  let args = action?.args ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return { ok: false, text: '', error: 'args 不是合法 JSON' };
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, text: '', error: 'args 必须是 JSON 对象' };
  }
  try {
    const result = await match.entry.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    if (result?.isError) {
      return {
        ok: false,
        text: contentToText(result?.content),
        error: firstErrorText(result) ?? '工具执行失败',
        transport: match.server.transport,
      };
    }
    return { ok: true, text: contentToText(result?.content), error: '', transport: match.server.transport };
  } catch (error) {
    return {
      ok: false,
      text: '',
      error: String(error?.message ?? error).slice(0, 500),
      transport: match.server.transport,
    };
  }
}

function firstErrorText(result) {
  const item = (Array.isArray(result?.content) ? result.content : []).find((entry) => entry?.type === 'text' && entry.text);
  return item ? String(item.text).slice(0, 500) : null;
}

function contentToText(content) {
  const items = Array.isArray(content) ? content : [];
  const parts = items.map((item) => {
    if (item?.type === 'text' && typeof item.text === 'string') return item.text;
    if (item?.type === 'resource' && item.resource) {
      const resource = item.resource;
      const body = typeof resource.text === 'string'
        ? resource.text
        : (resource.blob ? `（二进制内容 ${String(resource.blob).length} 字符 base64）` : '');
      return `[资源 ${resource.uri ?? ''}] ${body}`.trim();
    }
    if (item?.type === 'image') return '（工具返回了一张图片，无法在文本对话中展示）';
    return '';
  }).filter(Boolean);
  const text = parts.join('\n\n').trim();
  return text.slice(0, 20_000) || '（工具执行成功，无文本输出）';
}

/** 生成 system prompt 里的 MCP 工具清单段落；无可用工具时返回空串。 */
export function buildMcpPromptSection(tools, status = []) {
  const failed = status.filter((item) => !item.ok);
  const lines = [];
  if (tools.length) {
    lines.push(
      '用户还启用了以下 MCP 外部工具（来自独立进程/远程服务）。需要时在 actions 里返回 '
      + `{"type":"mcp","server":"<serverKey>","tool":"<toolName>","args":{...}}，系统会自动执行并把结果回填给你。`
      + '只能使用这里列出的 server/tool 组合；args 必须符合参数描述（JSON Schema）；执行失败时如实告知用户，不要编造结果。',
      '<mcp-tools>',
    );
    const byServer = new Map();
    for (const tool of tools) {
      if (!byServer.has(tool.server)) byServer.set(tool.server, []);
      byServer.get(tool.server).push(tool);
    }
    for (const [serverKey, serverTools] of byServer) {
      for (const tool of serverTools) {
        const schema = safeSchemaText(tool.inputSchema);
        lines.push(`[${serverKey}] ${tool.name}${tool.description ? ` — ${tool.description}` : ''}${schema ? `\n  参数: ${schema}` : ''}`);
      }
    }
    lines.push('</mcp-tools>');
  }
  if (failed.length) {
    lines.push(`另外，以下用户配置的 MCP Server 本次未能连接（相关请求请如实说明无法完成）：${failed.map((item) => `${item.name}（${item.error}）`).join('；')}`);
  }
  return lines.join('\n');
}

function safeSchemaText(schema) {
  try {
    const text = JSON.stringify(schema ?? {});
    if (text === '{"type":"object"}') return '';
    return text.length > MAX_TOOL_SCHEMA_CHARS ? `${text.slice(0, MAX_TOOL_SCHEMA_CHARS)}…（过长已截断）` : text;
  } catch {
    return '';
  }
}

/**
 * 预热 MCP 连接：打开连接并列出工具后立即释放引用。
 * 连接与工具清单留在池里（空闲 5 分钟回收），正式对话到达时 ensureConnection
 * 直接复用，把 spawn 进程 + listTools 的冷启动开销移出第一条消息的 TTFT。
 * 永不抛出：预热失败静默，正式对话仍按原路径自行连接。
 */
export async function warmupMcpConnections(inputServers) {
  try {
    const registry = await createMcpRegistry(inputServers);
    registry.release();
    return registry.status;
  } catch {
    return [];
  }
}

/** 测试与停机用：立刻关闭所有空闲缓存连接 */
export async function closeAllMcpConnections() {
  const entries = [...connections.values()];
  connections.clear();
  for (const entry of entries) {
    clearTimeout(entry.idleTimer);
    await entry.client.close().catch(() => {});
  }
}
