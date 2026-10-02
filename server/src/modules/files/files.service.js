import { config } from '../../config/index.js';
import { AppError, ConflictError, ValidationError } from '../../lib/errors.js';
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
  return guarded(() => store.previewMutation(action.type, action));
}

export function execute(action, { actor = 'local-user', source = 'files-api' } = {}) {
  return guarded(() => store.mutate(action.type, action, { actor, source }));
}

export function undo(operationId, { force = false, actor = 'local-user', source = 'files-api' } = {}) {
  return guarded(() => store.undo(operationId, { force, actor, source }));
}

export function log(limit) {
  return guarded(() => store.log(limit));
}

function guarded(task) {
  try {
    return task();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error?.message ?? 'File operation failed';
    if (/changed after|already exists|already undone|operation not found|no operation to undo/i.test(message)) {
      throw new ConflictError(message);
    }
    throw new ValidationError(message);
  }
}
