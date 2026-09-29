/**
 * AI 文件操作代理：动作规范化、预览、执行与审计。
 *
 * 从旧 ai.service.js 原样拆出 —— 模型只生成动作计划，所有写盘必须经过
 * preview（生成含风险标注的预览）→ 用户确认 → execute 三步。
 * 审计逐条 append JSONL，与业务数据同目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { ConflictError, ValidationError } from '../../lib/errors.js';
import { resolveVaultPath } from '../../vault/path.js';

const AUDIT_FILE = path.join(path.dirname(config.dbFile), 'ai-audit.jsonl');
export const MUTATING_ACTIONS = new Set(['create', 'update', 'delete', 'move', 'copy']);
export const ACTIONS = new Set(['read', ...MUTATING_ACTIONS]);
const MAX_READ_BYTES = 200_000;
const MAX_AUDIT_ENTRIES = 250;

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
    planHash: hashPlan(normalized),
    summary: summarizeOperations(operations),
    createdAt: new Date().toISOString(),
  };
}

export async function execute(actions = [], {
  actor = 'local-user',
  role = 'editor',
  confirmed = false,
  source = 'ai-chat',
  planHash = null,
  internalAutoApprove = false,
} = {}) {
  const normalized = normalizeActions(actions);
  const hasWrites = normalized.some((action) => MUTATING_ACTIONS.has(action.type));
  if (role === 'viewer' && hasWrites) {
    throw new ValidationError('当前角色只有读取权限，不能执行文件修改');
  }
  if (hasWrites && confirmed !== true) {
    throw new ValidationError('文件修改必须先确认操作预览');
  }
  if (hasWrites && !internalAutoApprove) {
    if (typeof planHash !== 'string' || !/^[a-f0-9]{64}$/i.test(planHash)) {
      throw new ValidationError('文件修改必须携带有效的操作计划');
    }
    if (hashPlan(normalized) !== planHash.toLowerCase()) {
      throw new ConflictError('文件在预览后已发生变化，请重新预览后再执行');
    }
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
  const sourceState = snapshotFile(source);
  const exists = sourceState.exists;
  const target = action.targetPath ? absoluteFilePath(action.targetPath) : null;
  const targetState = target ? snapshotFile(target) : null;
  const targetExists = targetState?.exists ?? false;
  const requiresConfirmation = MUTATING_ACTIONS.has(action.type);
  const risk = action.type === 'delete' ? 'destructive' : requiresConfirmation ? 'write' : 'read';

  return {
    ...action,
    id: action.id || `op-${index + 1}`,
    exists,
    isFile: sourceState.type === 'file',
    targetExists,
    targetIsFile: targetState?.type === 'file',
    risk,
    requiresConfirmation,
    summary: describeAction(action, exists, targetExists),
    before: sourceState.type === 'file'
      ? { size: sourceState.size, modifiedAt: sourceState.modifiedAt }
      : sourceState.exists ? { type: sourceState.type } : null,
    targetBefore: targetState?.exists
      ? targetState.type === 'file'
        ? { size: targetState.size, modifiedAt: targetState.modifiedAt }
        : { type: targetState.type }
      : null,
    after: action.type === 'delete' ? null : action.targetPath ? { path: action.targetPath } : action.type === 'read' ? null : { path: action.path },
  };
}

function snapshotFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { exists: true, type: 'directory', size: stat.size, modifiedAt: stat.mtime.toISOString() };
    }
    return {
      exists: true,
      type: 'file',
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, type: 'missing' };
    throw error;
  }
}

function hashPlan(actions) {
  const state = actions.map((action) => ({
    id: action.id,
    type: action.type,
    path: action.path,
    targetPath: action.targetPath ?? null,
    content: action.content,
    source: snapshotFile(absoluteFilePath(action.path)),
    target: action.targetPath ? snapshotFile(absoluteFilePath(action.targetPath)) : null,
  }));
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function describeAction(action, exists, targetExists) {
  const labels = { read: '读取', create: '创建', update: '更新', delete: '删除', move: '移动', copy: '复制' };
  const destination = action.targetPath ? ` → ${action.targetPath}` : '';
  if (action.type === 'create') return `${labels[action.type]} ${action.path}${exists ? '（目标已存在）' : ''}`;
  return `${labels[action.type]} ${action.path}${destination}${!exists ? '（源文件不存在）' : targetExists ? '（目标已存在）' : ''}`;
}

export function executeAction(action) {
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
