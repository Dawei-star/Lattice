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
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../vault/markdown.js';
import { assertWritablePathSync } from '../../vault/vault.adapter.js';
import { resolveVaultPath } from '../../vault/path.js';
import { createFileStore } from '../../../../scripts/fc-core.mjs';
import { auditAction, createOperationPlan } from '../../../../scripts/operation-plan.mjs';

const AUDIT_FILE = path.join(path.dirname(config.dbFile), 'ai-audit.jsonl');
export const MUTATING_ACTIONS = new Set(['create', 'update', 'delete', 'move', 'copy', 'archive']);
export const ACTIONS = new Set(['read', ...MUTATING_ACTIONS]);
const MAX_READ_BYTES = 200_000;
const MAX_AUDIT_ENTRIES = 250;
const fileStore = createFileStore(config.vaultDir);

/** vault 内部目录：AI 动作不得读写或改写（.lattice 存历史快照，walker 也不扫描） */
const FORBIDDEN_ACTION_DIRS = new Set(['.lattice', '.fc', '_templates']);

export function preview(actions = [], {
  actor = 'local-user',
  role = 'editor',
  source = 'ai-chat',
  planId = null,
} = {}) {
  const normalized = normalizeActions(actions);
  const operations = normalized.map((action, index) => previewAction(action, index));
  const blocked = role === 'viewer' && operations.some((operation) => operation.requiresConfirmation);
  const plan = createOperationPlan(normalized, { id: planId ?? randomUUID(), actor, role, source });

  return {
    id: plan.id,
    version: plan.version,
    actor,
    role,
    source,
    plan,
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
  planId = null,
  internalAutoApprove = false,
} = {}) {
  const normalized = normalizeActions(actions);
  const plan = createOperationPlan(normalized, { id: planId ?? randomUUID(), actor, role, source });
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
  // 自动批准只来自模型自答循环：检索到的笔记内容可能携带提示注入，
  // 删除是不可逆动作，绝不允许绕过用户确认自动执行。
  const executable = internalAutoApprove
    ? normalized.filter((action) => action.type !== 'delete')
    : normalized;
  const skippedDeletes = normalized.length - executable.length;

  const results = [];
  for (const action of executable) {
    try {
      const result = executeAction(action, {
        actor,
        role,
        source,
        planId: plan.id,
        planVersion: plan.version,
      });
      results.push({ id: action.id, type: action.type, path: action.path, targetPath: action.targetPath, status: 'completed', result });
      appendAudit({ plan, actor, role, source, action, status: 'completed', operationId: result?.operationId ?? null });
    } catch (error) {
      results.push({ id: action.id, type: action.type, path: action.path, targetPath: action.targetPath, status: 'failed', error: error?.message ?? '操作失败' });
      appendAudit({ plan, actor, role, source, action, status: 'failed', error: error?.message ?? '操作失败' });
    }
  }
  for (const action of normalized) {
    if (action.type !== 'delete') continue;
    // 与上面过滤动作对齐：delete 保持原样出现在结果里（而不是消失），
    // 让模型与前端都能看到"删除未执行"的原因
    if (executable.includes(action)) continue;
    const error = '删除操作需要用户逐次确认，不能自动执行';
    results.push({ id: action.id, type: action.type, path: action.path, targetPath: action.targetPath, status: 'skipped', error });
    appendAudit({ plan, actor, role, source, action, status: 'skipped', error });
  }

  return {
    planId: plan.id,
    planVersion: plan.version,
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

    if (type === 'move' || type === 'copy' || type === 'archive') normalized.targetPath = normalizeFilePath(raw.targetPath ?? raw.toPath ?? raw.destination);
    if ((type === 'create' || type === 'update') && normalized.content === undefined) {
      throw new ValidationError(`${type} 操作必须包含 content`);
    }
    assertNotInternalPath(normalized.path);
    if (normalized.targetPath !== undefined) assertNotInternalPath(normalized.targetPath);
    return normalized;
  });
}

/** AI 动作不允许触及内部目录：模型输出可能被笔记内容注入，历史快照与模板必须隔离 */
function assertNotInternalPath(relativePath) {
  const firstSegment = String(relativePath).split('/')[0];
  if (FORBIDDEN_ACTION_DIRS.has(firstSegment)) {
    throw new ValidationError(`不允许操作 Vault 内部目录：${relativePath}`);
  }
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
  const labels = { read: '读取', create: '创建', update: '更新', delete: '删除', move: '移动', copy: '复制', archive: '归档' };
  const destination = action.targetPath ? ` → ${action.targetPath}` : '';
  if (action.type === 'create') return `${labels[action.type]} ${action.path}${exists ? '（目标已存在）' : ''}`;
  return `${labels[action.type]} ${action.path}${destination}${!exists ? '（源文件不存在）' : targetExists ? '（目标已存在）' : ''}`;
}

export function executeAction(action, {
  actor = 'local-user',
  role = 'editor',
  source: auditSource = 'ai-chat',
  planId = null,
  planVersion = 1,
} = {}) {
  const source = absoluteFilePath(action.path);
  const target = action.targetPath ? absoluteFilePath(action.targetPath) : null;
  const assertWritable = (absolutePath) => assertWritablePathSync(path.resolve(config.vaultDir), absolutePath);

  // 与 vault.adapter 其余写路径同一约定：写入前拒绝穿越符号链接，
  // 覆写统一走 tmp+rename 原子写，避免崩溃/断电把原文件截断损坏。
  if (action.type === 'read') {
    const result = fileStore.read(action.path, { limit: MAX_READ_BYTES });
    return { content: result.content, size: result.size };
  }
  if (['create', 'update', 'delete', 'move', 'copy'].includes(action.type)) {
    const mutationType = action.type === 'update' ? 'write' : action.type;
    const result = fileStore.mutate(mutationType, {
      path: action.path,
      targetPath: action.targetPath,
      content: action.content,
    }, { actor, role, source: auditSource, planId, planVersion, actionId: action.id });
    // operationId 透出：前端可凭它调用 /api/files/undo 撤销本次写入
    const operationId = result?.operationId ?? null;
    if (['create', 'update', 'delete'].includes(action.type)) return { path: action.path, operationId };
    return { fromPath: result.fromPath, toPath: result.toPath, operationId };
  }
  if (action.type === 'archive') {
    if (!fs.existsSync(source)) throw new Error('源文件不存在');
    if (!fs.statSync(source).isFile()) throw new Error('只允许归档文件');
    if (!target) throw new Error('归档必须指定目标路径');
    if (fs.existsSync(target)) throw new Error('目标文件已存在');
    // 与其余写路径同一约定：读写前拒绝穿越符号链接
    assertWritable(source);
    assertWritable(target);

    const document = parseMarkdownDocument(fs.readFileSync(source, 'utf8'), action.path);
    if (document.properties?.type !== 'inbox') throw new Error('只允许归档 Inbox 文件');
    const properties = { ...(document.properties ?? {}), status: 'processed' };
    delete properties.type;
    const archived = serializeMarkdownDocument({
      ...document,
      filePath: action.targetPath,
      properties,
    });
    const temporary = `${target}.${randomUUID()}.tmp`;
    let createdTarget = false;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temporary, archived, 'utf8');
      fs.renameSync(temporary, target);
      createdTarget = true;
      fs.unlinkSync(source);
    } catch (error) {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      if (createdTarget && fs.existsSync(target)) fs.rmSync(target, { force: true });
      throw error;
    }
    return { fromPath: action.path, toPath: action.targetPath, status: 'processed' };
  }
  // read / create / update / delete / move / copy / archive 之外没有其他动作类型，
  // 这里不应再有任何执行分支
  throw new ValidationError(`不支持的操作类型：${action.type}`);
}

function summarizeOperations(operations) {
  const writes = operations.filter((operation) => operation.requiresConfirmation).length;
  const reads = operations.length - writes;
  return `${operations.length} 项操作 · ${writes} 项需要确认${reads ? ` · ${reads} 项读取` : ''}`;
}

export function recordAudit(entry) {
  const action = entry.action ?? {};
  const plan = entry.plan ?? createOperationPlan([action], {
    id: entry.planId ?? randomUUID(),
    actor: entry.actor ?? 'local-user',
    role: entry.role ?? 'editor',
    source: entry.source ?? 'api',
  });
  appendAudit({ ...entry, plan, action });
}

function appendAudit(entry) {
  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  const safeEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    planVersion: entry.plan?.version ?? 1,
    planId: entry.plan?.id ?? entry.planId ?? null,
    actor: entry.actor,
    role: entry.role,
    source: entry.source,
    status: entry.status,
    type: entry.action?.type ?? null,
    path: entry.action?.path ?? null,
    targetPath: entry.action?.targetPath ?? null,
    action: auditAction(entry.action),
    ...(entry.operationId ? { operationId: entry.operationId } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(safeEntry)}\n`, 'utf8');
}
