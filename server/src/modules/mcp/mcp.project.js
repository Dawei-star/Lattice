/**
 * 项目级 MCP 配置：<VaultRoot>/.lattice/mcp.json。
 *
 * 「设置 → MCP Server → 启用项目级 MCP」打开后，这里定义的 Server 会随用户级
 * 配置一起进入 AI 聊天（用户级同名优先），让一个知识库可以自带它需要的工具配置，
 * 换机器 / 换账号只要带着 Vault 就行。
 *
 * 磁盘格式对齐 Claude Desktop / 各类 MCP 客户端的习惯，手改文件即可生效：
 * {
 *   "mcpServers": {
 *     "git": { "command": "uvx", "args": ["mcp-server-git", "--repository", "D:/repo"] },
 *     "docs": { "url": "https://example.com/mcp", "transport": "sse" }
 *   }
 * }
 * 也容忍顶层直接就是 { "<key>": {...} } 的裸映射（与设置页「导入」同一口径）。
 *
 * 文件放在 .lattice 内部目录：watcher 与笔记 walker 都会跳过，不会被当成笔记入库。
 * 读写模式与 vault/profile.js 一致（原子写 + 坏文件不炸服务，如实上报 warning）。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.js';
import { ValidationError } from '../../lib/errors.js';
import { resolveVaultDir } from '../../vault/config.js';

const CONFIG_DIRECTORY = '.lattice';
const CONFIG_FILE_NAME = 'mcp.json';
const MAX_SERVERS = 16;
const MAX_KEY_LENGTH = 80;
const MAX_FIELD_LENGTH = 4096;
const MAX_ENV_ENTRIES = 64;

export function projectMcpFilePath(vaultDir = config.vaultDir) {
  return path.join(path.resolve(resolveVaultDir(vaultDir)), CONFIG_DIRECTORY, CONFIG_FILE_NAME);
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function normalizeArgs(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map((item) => item.slice(0, MAX_FIELD_LENGTH)).slice(0, 64)
    : [];
}

function normalizeEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, item]) => typeof name === 'string' && name && typeof item === 'string')
      .slice(0, MAX_ENV_ENTRIES)
      .map(([name, item]) => [name.slice(0, 200), item.slice(0, MAX_FIELD_LENGTH)]),
  );
}

/** 单个 server 条目：宽容解析（多余字段直接丢弃），返回 null 表示条目不可用 */
function normalizeServerEntry(key, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const normalizedKey = asString(key).trim().slice(0, MAX_KEY_LENGTH);
  if (!normalizedKey) return null;
  const transport = raw.transport === 'sse' || typeof raw.url === 'string' && raw.url.trim() ? 'sse' : 'stdio';
  const server = {
    key: normalizedKey,
    name: asString(raw.name, normalizedKey).trim().slice(0, 120) || normalizedKey,
    description: asString(raw.description).slice(0, 300),
    transport,
    command: asString(raw.command).trim().slice(0, MAX_FIELD_LENGTH),
    args: normalizeArgs(raw.args),
    env: normalizeEnv(raw.env),
    url: asString(raw.url).trim().slice(0, MAX_FIELD_LENGTH),
    enabled: raw.enabled !== false,
  };
  if (server.transport === 'stdio' && !server.command) return null;
  if (server.transport === 'sse' && !/^https?:\/\//i.test(server.url)) return null;
  return server;
}

/** 把磁盘文档（mcpServers 包裹或裸映射）归一化为内部 server 列表 */
export function normalizeProjectDocument(document) {
  const source = document && typeof document === 'object' && !Array.isArray(document)
    ? (document.mcpServers && typeof document.mcpServers === 'object' && !Array.isArray(document.mcpServers)
      ? document.mcpServers
      : document)
    : null;
  if (!source) return [];
  const servers = [];
  const seen = new Set();
  for (const [key, raw] of Object.entries(source)) {
    const server = normalizeServerEntry(key, raw);
    if (!server || seen.has(server.key)) continue;
    seen.add(server.key);
    servers.push(server);
    if (servers.length >= MAX_SERVERS) break;
  }
  return servers;
}

/** 读项目配置。文件缺失是常态（返回 status:'default'），坏文件不炸服务、如实上报。 */
export function loadProjectMcpConfig(vaultDir = config.vaultDir) {
  const filePath = projectMcpFilePath(vaultDir);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { filePath, status: 'default', warning: null, servers: [] };
    }
    return { filePath, status: 'invalid', warning: `无法读取配置：${error.message}`, servers: [] };
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return { filePath, status: 'invalid', warning: `JSON 解析失败：${error.message}`, servers: [] };
  }
  return { filePath, status: 'loaded', warning: null, servers: normalizeProjectDocument(document) };
}

/** 保存项目配置。document 允许 mcpServers 包裹或裸映射；条目经归一化后落盘。 */
export function saveProjectMcpConfig(document, vaultDir = config.vaultDir) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new ValidationError('项目级 MCP 配置必须是 JSON 对象');
  }
  const source = document.mcpServers && typeof document.mcpServers === 'object' && !Array.isArray(document.mcpServers)
    ? document.mcpServers
    : document;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new ValidationError('mcpServers 必须是对象映射');
  }
  const servers = normalizeProjectDocument(document);
  const normalizedSource = Object.fromEntries(servers.map((server) => [server.key, {
    name: server.name,
    description: server.description,
    transport: server.transport,
    ...(server.transport === 'sse'
      ? { url: server.url }
      : { command: server.command, args: server.args }),
    env: server.env,
    enabled: server.enabled,
  }]));
  const dropped = Object.keys(source).length - servers.length;
  const filePath = projectMcpFilePath(vaultDir);
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ mcpServers: normalizedSource }, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || !fs.existsSync(filePath)) throw error;
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temporary, filePath);
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  const result = loadProjectMcpConfig(vaultDir);
  result.warning = dropped > 0 ? `${dropped} 个无效条目已被忽略（缺 command / URL 非法等）。` : null;
  return result;
}
