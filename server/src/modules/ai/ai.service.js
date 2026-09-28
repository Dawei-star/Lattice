import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { ValidationError } from '../../lib/errors.js';
import { resolveVaultPath } from '../../vault/path.js';
import * as searchService from '../search/search.service.js';

const AUDIT_FILE = path.join(path.dirname(config.dbFile), 'ai-audit.jsonl');
const MUTATING_ACTIONS = new Set(['create', 'update', 'delete', 'move', 'copy']);
const ACTIONS = new Set(['read', ...MUTATING_ACTIONS]);
const MAX_READ_BYTES = 200_000;
const MAX_AUDIT_ENTRIES = 250;

export async function chat({ message, context = {}, provider = null, actor = 'local-user', role = 'editor' }) {
  const cleanMessage = String(message ?? '').trim();
  if (!cleanMessage) throw new ValidationError('消息不能为空');

  if (provider?.endpoint && provider?.apiKey) {
    try {
      return await callCompatibleProvider({ cleanMessage, context, provider, actor, role });
    } catch (error) {
      const fallback = buildLocalResponse(cleanMessage, context);
      return {
        ...fallback,
        meta: { provider: 'local-fallback', providerError: error?.message ?? '外部 AI 暂时不可用' },
      };
    }
  }

  return { ...buildLocalResponse(cleanMessage, context), meta: { provider: 'local' } };
}

export function preview(actions = [], { actor = 'local-user', role = 'editor' } = {}) {
  const normalized = normalizeActions(actions);
  const operations = normalized.map((action, index) => previewAction(action, index));
  const blocked = role === 'viewer' && operations.some((operation) => operation.requiresConfirmation);

  return {
    id: randomUUID(),
    actor,
    role,
    blocked,
    operations,
    summary: summarizeOperations(operations),
    createdAt: new Date().toISOString(),
  };
}

export async function execute(actions = [], { actor = 'local-user', role = 'editor', confirmed = false, source = 'ai-chat' } = {}) {
  const normalized = normalizeActions(actions);
  const hasWrites = normalized.some((action) => MUTATING_ACTIONS.has(action.type));
  if (role === 'viewer' && hasWrites) {
    throw new ValidationError('当前角色只有读取权限，不能执行文件修改');
  }
  if (hasWrites && confirmed !== true) {
    throw new ValidationError('文件修改必须先确认操作预览');
  }

  const results = [];
  for (const action of normalized) {
    try {
      const result = executeAction(action);
      results.push({ id: action.id, type: action.type, path: action.path, targetPath: action.targetPath, status: 'completed', result });
      appendAudit({ actor, role, source, action, status: 'completed' });
    } catch (error) {
      results.push({ id: action.id, type: action.type, path: action.path, targetPath: action.targetPath, status: 'failed', error: error?.message ?? '操作失败' });
      appendAudit({ actor, role, source, action, status: 'failed', error: error?.message ?? '操作失败' });
    }
  }

  return {
    results,
    completed: results.filter((item) => item.status === 'completed').length,
    failed: results.filter((item) => item.status === 'failed').length,
  };
}

export function history(limit = 80) {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-Math.min(Math.max(Number(limit) || 80, 1), MAX_AUDIT_ENTRIES)).reverse().flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function normalizeActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 30) {
    throw new ValidationError('至少需要一个文件操作，单次最多 30 个操作');
  }

  return actions.map((raw, index) => {
    const type = String(raw?.type ?? '').toLowerCase();
    if (!ACTIONS.has(type)) throw new ValidationError(`不支持的文件操作：${type || `第 ${index + 1} 项`}`);

    const pathValue = raw.path ?? raw.sourcePath ?? raw.fromPath;
    const normalized = {
      id: String(raw.id ?? `op-${index + 1}`),
      type,
      path: normalizeFilePath(pathValue),
      targetPath: undefined,
      content: raw.content === undefined ? undefined : String(raw.content),
    };

    if (type === 'move' || type === 'copy') normalized.targetPath = normalizeFilePath(raw.targetPath ?? raw.toPath ?? raw.destination);
    if ((type === 'create' || type === 'update') && normalized.content === undefined) {
      throw new ValidationError(`${type} 操作必须包含 content`);
    }
    return normalized;
  });
}

function normalizeFilePath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError('文件路径不能为空');
  try {
    const absolute = resolveVaultPath(config.vaultDir, value.trim(), '');
    return path.relative(path.resolve(config.vaultDir), absolute).replaceAll('\\', '/');
  } catch {
    throw new ValidationError(`非法 Vault 文件路径：${value}`);
  }
}

function absoluteFilePath(relativePath) {
  return resolveVaultPath(config.vaultDir, relativePath, '');
}

function previewAction(action, index) {
  const source = absoluteFilePath(action.path);
  const exists = fs.existsSync(source);
  const sourceStat = exists ? fs.statSync(source) : null;
  const target = action.targetPath ? absoluteFilePath(action.targetPath) : null;
  const targetExists = target ? fs.existsSync(target) : false;
  const targetStat = targetExists ? fs.statSync(target) : null;
  const requiresConfirmation = MUTATING_ACTIONS.has(action.type);
  const risk = action.type === 'delete' ? 'destructive' : requiresConfirmation ? 'write' : 'read';

  return {
    ...action,
    id: action.id || `op-${index + 1}`,
    exists,
    isFile: sourceStat?.isFile() ?? false,
    targetExists,
    targetIsFile: targetStat?.isFile() ?? false,
    risk,
    requiresConfirmation,
    summary: describeAction(action, exists, targetExists),
    before: sourceStat?.isFile() ? describeFile(source) : sourceStat ? { type: 'directory' } : null,
    after: action.type === 'delete' ? null : action.targetPath ? { path: action.targetPath } : action.type === 'read' ? null : { path: action.path },
  };
}

function describeFile(filePath) {
  const stat = fs.statSync(filePath);
  return { size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

function describeAction(action, exists, targetExists) {
  const labels = { read: '读取', create: '创建', update: '更新', delete: '删除', move: '移动', copy: '复制' };
  const destination = action.targetPath ? ` → ${action.targetPath}` : '';
  if (action.type === 'create') return `${labels[action.type]} ${action.path}${exists ? '（目标已存在）' : ''}`;
  return `${labels[action.type]} ${action.path}${destination}${!exists ? '（源文件不存在）' : targetExists ? '（目标已存在）' : ''}`;
}

function executeAction(action) {
  const source = absoluteFilePath(action.path);
  const target = action.targetPath ? absoluteFilePath(action.targetPath) : null;

  if (action.type === 'read') {
    if (!fs.existsSync(source)) throw new Error('源文件不存在');
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error('目标不是文件');
    if (stat.size > MAX_READ_BYTES) throw new Error('文件过大，读取已停止');
    return { content: fs.readFileSync(source, 'utf8'), size: stat.size };
  }
  if (action.type === 'create') {
    if (fs.existsSync(source)) throw new Error('目标文件已存在');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, action.content ?? '', 'utf8');
    return { path: action.path };
  }
  if (action.type === 'update') {
    if (!fs.existsSync(source)) throw new Error('源文件不存在');
    fs.writeFileSync(source, action.content ?? '', 'utf8');
    return { path: action.path };
  }
  if (action.type === 'delete') {
    if (!fs.existsSync(source)) throw new Error('源文件不存在');
    if (!fs.statSync(source).isFile()) throw new Error('只允许删除文件');
    fs.rmSync(source);
    return { path: action.path };
  }
  if (!fs.existsSync(source)) throw new Error('源文件不存在');
  if (!fs.statSync(source).isFile()) throw new Error('只允许移动或复制文件');
  if (target && fs.existsSync(target)) throw new Error('目标文件已存在');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (action.type === 'move') fs.renameSync(source, target);
  else fs.copyFileSync(source, target);
  return { fromPath: action.path, toPath: action.targetPath };
}

function summarizeOperations(operations) {
  const writes = operations.filter((operation) => operation.requiresConfirmation).length;
  const reads = operations.length - writes;
  return `${operations.length} 项操作 · ${writes} 项需要确认${reads ? ` · ${reads} 项读取` : ''}`;
}

function appendAudit(entry) {
  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  const safeEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    actor: entry.actor,
    role: entry.role,
    source: entry.source,
    status: entry.status,
    action: {
      id: entry.action.id,
      type: entry.action.type,
      path: entry.action.path,
      targetPath: entry.action.targetPath,
    },
    ...(entry.error ? { error: entry.error } : {}),
  };
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(safeEntry)}\n`, 'utf8');
}

async function callCompatibleProvider({ cleanMessage, context, provider }) {
  const endpoint = normalizeProviderEndpoint(provider.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('AI endpoint 必须使用 HTTP 或 HTTPS');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        [provider.authHeader === 'x-api-key' ? 'x-api-key' : 'Authorization']: provider.authHeader === 'x-api-key' ? provider.apiKey : `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model || 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: buildSystemPrompt(context) },
          { role: 'user', content: cleanMessage },
        ],
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let payload = null;
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) throw new Error(formatProviderError(response.status, payload, responseText));
    const raw = payload?.choices?.[0]?.message?.content ?? payload?.output_text ?? '';
    if (!raw) throw new Error('外部 AI 没有返回内容');
    return { ...parseAssistantPayload(raw, context), meta: { provider: 'external', model: provider.model || 'default' } };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeProviderEndpoint(value) {
  const endpoint = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('AI endpoint must use HTTP or HTTPS');
  const pathname = endpoint.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(pathname)) return endpoint;
  if (/\/v1$/i.test(pathname)) endpoint.pathname = `${pathname}/chat/completions`;
  return endpoint;
}

function formatProviderError(status, payload, rawText) {
  const detail = payload?.error?.message
    ?? payload?.message
    ?? payload?.error?.detail
    ?? (rawText || '').replace(/\s+/g, ' ').trim();
  const safeDetail = String(detail || '').slice(0, 500);
  if (status === 401) return '智谱 API Key 无效或已过期，请重新生成 Key';
  if (status === 403 && /model/i.test(safeDetail)) {
    return `当前 API Key 没有模型权限：${safeDetail}`;
  }
  return safeDetail ? `External AI returned HTTP ${status}: ${safeDetail}` : `External AI returned HTTP ${status}`;
}

function buildSystemPrompt(context) {
  return [
    '你是 Lattice 的本地文件管理助手。只返回 JSON，不要使用 Markdown 代码围栏。',
    'JSON 结构必须是：{"reply":"...","suggestions":[],"references":[],"actions":[]}',
    'actions 类型只能是 read/create/update/delete/move/copy。每个动作包含 type、path，可选 targetPath/content。不要执行动作，只生成计划。',
    '所有写操作必须让用户确认，不能生成 Vault 外的绝对路径或 .. 路径。',
    `当前上下文：${JSON.stringify({ activeFile: context.activeFile ?? null, files: (context.files ?? []).slice(0, 80), folders: (context.folders ?? []).slice(0, 40) })}`,
  ].join('\n');
}

function parseAssistantPayload(raw, context) {
  const text = String(raw).trim();
  const candidate = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(candidate);
    return {
      reply: String(parsed.reply ?? '已生成文件操作计划。'),
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 8) : [],
      references: Array.isArray(parsed.references) ? parsed.references.slice(0, 12) : [],
      actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 30) : [],
    };
  } catch {
    return { reply: text, suggestions: [], references: [], actions: [] };
  }
}

function buildLocalResponse(message, context) {
  const lower = message.toLowerCase();
  const files = Array.isArray(context.files) ? context.files : [];
  const quoted = [...message.matchAll(/[“”"']([^“”"']+)[“”"']/g)].map((match) => match[1].trim()).filter(Boolean);
  const actions = [];
  const suggestions = [];
  let references = [];

  const searchMatch = message.match(/(?:搜索|查找|找出|关于|包含|search|find)\s*[：:]?\s*(.+)$/i);
  if (searchMatch) {
    const query = searchMatch[1].replace(/[“”"']/g, '').trim().slice(0, 200);
    try {
      references = searchService.search(query, 8).items;
    } catch {
      references = files.filter((file) => `${file.title ?? ''} ${file.path ?? ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
    }
    return {
      reply: references.length ? `找到 ${references.length} 个相关文件，可以从结果中打开。` : `没有找到与“${query}”匹配的文件。`,
      suggestions: references.length ? ['把结果移动到指定目录', '为结果生成统一标签'] : ['换一个更具体的关键词', '检查文件名或内容'],
      references,
      actions,
    };
  }

  if (/(整理|分类|归档|organize|categor)/i.test(lower)) {
    const fileCount = files.length ? `${files.length} 个文件` : '现有文件';
    suggestions.push(
      { title: '按文件类型分组', detail: `${fileCount}可以按 Markdown、画布和资源分组` },
      { title: '补充标签', detail: '根据标题和内容生成候选标签，确认后再写回文件' },
      { title: '统一命名', detail: '检测重复前缀、日期格式和过长文件名' },
    );
    return { reply: '我先整理出一组低风险建议，写入或移动文件前会显示预览。', suggestions, references, actions };
  }

  if (/(删除|移除|delete|remove)/i.test(lower) && quoted[0]) actions.push({ type: 'delete', path: quoted[0] });
  else if (/(创建|新建|create)/i.test(lower) && quoted[0]) actions.push({ type: 'create', path: quoted[0], content: '# 新文件\n\n' });
  else if (/(移动|move)/i.test(lower) && quoted.length >= 2) actions.push({ type: 'move', path: quoted[0], targetPath: quoted[1] });
  else if (/(复制|copy)/i.test(lower) && quoted.length >= 2) actions.push({ type: 'copy', path: quoted[0], targetPath: quoted[1] });
  else if (/(读取|打开|read|open)/i.test(lower) && quoted[0]) actions.push({ type: 'read', path: quoted[0] });

  if (/(检查|错误|校对|lint|review)/i.test(lower)) {
    suggestions.push({ title: '检查 Markdown 结构', detail: '检查标题层级、空链接、未闭合代码块和重复标签' });
  }
  if (/(转换|格式|convert|format)/i.test(lower)) {
    suggestions.push({ title: '转换格式', detail: '可将当前内容整理为 Markdown、纯文本或结构化清单' });
  }

  return {
    reply: actions.length ? '已识别出文件操作，下面先生成预览。' : '我可以帮你搜索、整理、重命名、编辑、复制、移动或删除 Vault 文件。',
    suggestions,
    references,
    actions,
  };
}
