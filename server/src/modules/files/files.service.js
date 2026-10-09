import { config } from '../../config/index.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { createFileStore } from '../../../../scripts/fc-core.mjs';

const store = createFileStore(config.vaultDir);

export function read(query) {
  return guarded(() => store.read(query.path, { offset: query.offset, limit: query.limit }));
}

export function find(query) {
  return guarded(() => store.find(query.pattern, query.dir, { type: query.type }));
}

export function grep(query) {
  return guarded(() => store.grep(query.query, query.dir, { regex: query.regex, type: query.type }));
}

export function preview(action) {
  return guarded(() => Array.isArray(action.actions)
    ? store.previewBatch(action.actions)
    : store.previewMutation(action.type, action));
}

export function execute(action, {
  actor = 'local-user',
  role = 'editor',
  source = 'files-api',
  planId = null,
  planHash = null,
} = {}) {
  return guarded(() => Array.isArray(action.actions)
    ? store.mutateBatch(action.actions, { actor, role, source, planId, planHash })
    : store.mutate(action.type, action, { actor, role, source, planId, planHash }));
}

export function undo(operationId, { force = false, actor = 'local-user', role = 'editor', source = 'files-api' } = {}) {
  return guarded(() => store.undo(operationId, { force, actor, role, source }));
}

export function log(limit) {
  return guarded(() => store.log(limit));
}

function guarded(task) {
  try {
    return task();
  } catch (error) {
    if (error instanceof AppError) throw error;
    // fc-core 只抛带文本的普通 Error，这里按消息短语映射 HTTP 语义：
    // 并发/冲突 → 409，路径不存在 → 404，其余输入问题 → 422
    const message = error?.message ?? 'File operation failed';
    if (/changed after|already exists|already undone|operation not found|no operation to undo|plan hash mismatch|cannot undo/i.test(message)) {
      throw new ConflictError(message);
    }
    if (/does not exist|^Not a file:|^Not a directory:/i.test(message)) {
      throw new NotFoundError(message);
    }
    throw new ValidationError(message);
  }
}
