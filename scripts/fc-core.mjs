import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { OPERATION_PLAN_VERSION, auditAction, createOperationPlan } from './operation-plan.mjs';

const INTERNAL_DIR = '.fc';
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_GREP_BYTES = 4 * 1024 * 1024;
const MUTATIONS = new Set(['create', 'write', 'append', 'edit', 'copy', 'move', 'delete', 'mkdir']);

export class FileStore {
  constructor(rootDir) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw new Error('A root directory is required');
    this.rootDir = path.resolve(rootDir);
    this.stateDir = path.join(this.rootDir, INTERNAL_DIR);
    this.trashDir = path.join(this.stateDir, 'trash');
    this.auditFile = path.join(this.stateDir, 'audit.jsonl');
  }

  read(relativePath, { offset = 0, limit = MAX_READ_BYTES } = {}) {
    const safePath = normalizeRelativePath(relativePath);
    const filePath = this.resolve(safePath);
    assertRegularFile(filePath, safePath);
    const raw = fs.readFileSync(filePath);
    const start = Math.max(Number(offset) || 0, 0);
    const max = Math.min(Math.max(Number(limit) || MAX_READ_BYTES, 1), MAX_READ_BYTES);
    const content = raw.toString('utf8');
    const slice = content.slice(start, start + max);
    return {
      path: safePath,
      size: raw.byteLength,
      offset: start,
      limit: max,
      eof: start + slice.length >= content.length,
      content: slice,
    };
  }

  stat(relativePath) {
    const safePath = normalizeRelativePath(relativePath);
    const filePath = this.resolve(safePath);
    try {
      return fileStat(safePath, filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return { path: safePath, exists: false, type: 'missing' };
      throw error;
    }
  }

  find(pattern = '**/*', relativeDir = '', { type = null } = {}) {
    const base = this.resolveDirectory(relativeDir);
    const normalizedPattern = normalizePattern(pattern);
    const matcher = globToRegExp(normalizedPattern);
    const extension = type ? (String(type).startsWith('.') ? String(type).toLowerCase() : `.${type}`.toLowerCase()) : null;
    const items = this.listFiles(base).filter((filePath) => {
      const relativePath = toPortable(path.relative(this.rootDir, filePath));
      const matchPath = toPortable(path.relative(base, filePath));
      if (!matcher.test(matchPath)) return false;
      return !extension || path.extname(relativePath).toLowerCase() === extension;
    }).map((filePath) => fileInfo(this.rootDir, filePath));
    return { pattern: normalizedPattern, items, total: items.length };
  }

  grep(query, relativeDir = '', { regex = false, type = null } = {}) {
    if (typeof query !== 'string' || !query) throw new Error('A grep query is required');
    const base = this.resolveDirectory(relativeDir);
    const extension = type ? (String(type).startsWith('.') ? String(type).toLowerCase() : `.${type}`.toLowerCase()) : null;
    let matcher;
    try {
      matcher = regex ? new RegExp(query, 'i') : null;
    } catch (error) {
      throw new Error(`Invalid regular expression: ${error.message}`);
    }
    const items = [];
    for (const filePath of this.listFiles(base)) {
      const relativePath = toPortable(path.relative(this.rootDir, filePath));
      if (extension && path.extname(relativePath).toLowerCase() !== extension) continue;
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_GREP_BYTES) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        const matched = matcher ? matcher.test(line) : line.toLocaleLowerCase().includes(query.toLocaleLowerCase());
        if (matched) items.push({ path: relativePath, line: index + 1, text: line });
      });
    }
    return { query, regex, items, total: items.length };
  }

  previewMutation(type, input = {}) {
    const action = normalizeAction(type, input);
    const changes = previewPaths(action).map((relativePath) => ({
      path: relativePath,
      before: stateFor(this.resolve(relativePath)),
    }));
    const preview = {
      type: action.type,
      path: action.path,
      ...(action.targetPath ? { targetPath: action.targetPath } : {}),
      summary: describeAction(action, changes),
      changes,
      planHash: singlePlanHash(action, changes),
    };

    if (['create', 'write', 'append', 'edit'].includes(action.type)) {
      const current = readTextIfPresent(this.resolve(action.path));
      const next = nextText(action, current);
      preview.diff = unifiedDiff(action.path, current ?? '', next);
      preview.after = stateForText(next);
    }
    return preview;
  }

  previewBatch(actions = []) {
    const normalized = normalizeBatchActions(actions);
    const operations = normalized.map((action) => this.previewMutation(action.type, action));
    const counts = operations.reduce((result, operation) => {
      result[operation.type] = (result[operation.type] ?? 0) + 1;
      return result;
    }, {});
    return {
      planHash: batchPlanHash(normalized, operations),
      total: operations.length,
      counts,
      summary: describeBatch(operations, counts),
      operations,
    };
  }

  mutate(type, input = {}, {
    dryRun = false,
    actor = 'local-user',
    role = 'editor',
    source = 'fc',
    batchId = null,
    planId = null,
    planVersion = OPERATION_PLAN_VERSION,
    actionId = null,
    planHash = null,
  } = {}) {
    const action = normalizeAction(type, input);
    const preview = this.previewMutation(action.type, action);
    assertPlanHash(planHash, preview.planHash, 'Operation plan hash mismatch');
    if (dryRun) return { dryRun: true, ...preview };

    const operationId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const plan = createOperationPlan([{
      ...action,
      ...(actionId ? { id: actionId } : {}),
    }], { id: planId ?? randomUUID(), actor, role, source });
    const operationDir = path.join(this.trashDir, operationId);
    const snapshotDir = path.join(operationDir, 'files');
    fs.mkdirSync(snapshotDir, { recursive: true });
    const entries = [];
    let applied = false;
    try {
      for (const [index, relativePath] of this.changePaths(action).entries()) {
        entries.push(captureEntry(this.rootDir, relativePath, snapshotDir, index));
      }
      const result = applyAction(this, action);
      applied = true;
      for (const entry of entries) entry.after = stateFor(this.resolve(entry.path));
      const manifest = {
        id: operationId,
        type: action.type,
        path: action.path,
        ...(action.targetPath ? { targetPath: action.targetPath } : {}),
        planVersion: plan.version,
        planId: plan.id,
        createdAt: new Date().toISOString(),
        entries,
      };
      writeJson(path.join(operationDir, 'manifest.json'), manifest);
      appendJsonl(this.auditFile, auditEntry({
        id: operationId,
        at: manifest.createdAt,
        action: plan.actions[0],
        plan,
        operationId,
        batchId,
        actor,
        role,
        source,
        status: 'completed',
      }));
      return { operationId, planId: plan.id, planVersion: plan.version, undoable: true, ...result, preview };
    } catch (error) {
      // 动作尚未落盘时才清场；一旦文件已被修改，快照目录必须保留——
      // 否则这次变更既不能撤销，也不留任何审计痕迹
      if (!applied) fs.rmSync(operationDir, { recursive: true, force: true });
      throw error;
    }
  }

  mutateBatch(actions = [], {
    dryRun = false,
    actor = 'local-user',
    role = 'editor',
    source = 'fc-batch',
    planHash = null,
    planId = null,
  } = {}) {
    const normalized = normalizeBatchActions(actions);
    const preview = this.previewBatch(normalized);
    if (planHash && planHash !== preview.planHash) {
      throw new Error(`Batch plan hash mismatch: expected ${planHash}, current ${preview.planHash}`);
    }
    if (dryRun) return { dryRun: true, ...preview };

    const batchId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const plan = createOperationPlan(normalized, { id: planId ?? randomUUID(), actor, role, source });
    const results = [];
    const completed = [];
    try {
      for (const [index, action] of normalized.entries()) {
        const result = this.mutate(action.type, action, {
          actor,
          role,
          source,
          batchId,
          planId: plan.id,
          planVersion: plan.version,
          actionId: plan.actions[index].id,
        });
        results.push(result);
        completed.push({ operationId: result.operationId, type: action.type, path: action.path, ...(action.targetPath ? { targetPath: action.targetPath } : {}) });
      }
    } catch (error) {
      error.code = 'BATCH_PARTIAL_FAILURE';
      error.details = {
        batchId,
        planHash: preview.planHash,
        completed,
        failed: { message: error.message },
      };
      throw error;
    }
    return {
      batchId,
      planId: plan.id,
      planVersion: plan.version,
      planHash: preview.planHash,
      total: results.length,
      operationIds: results.map((result) => result.operationId),
      results,
      preview,
    };
  }

  undo(operationId = null, { force = false, actor = 'local-user', role = 'editor', source = 'fc' } = {}) {
    const manifest = this.findManifest(operationId);
    if (!manifest) throw new Error(operationId ? `Operation not found: ${operationId}` : 'There is no operation to undo');
    if (manifest.undoneAt) throw new Error(`Operation already undone: ${manifest.id}`);

    if (!force) {
      for (const entry of manifest.entries) {
        const current = stateFor(this.resolve(entry.path));
        if (!sameState(current, entry.after)) {
          throw new Error(`Cannot undo ${manifest.id}: file changed after the operation (${entry.path})`);
        }
      }
    }

    for (const entry of [...manifest.entries].reverse()) restoreEntry(this.rootDir, entry, path.dirname(path.join(this.trashDir, manifest.id, 'manifest.json')));
    manifest.undoneAt = new Date().toISOString();
    writeJson(path.join(this.trashDir, manifest.id, 'manifest.json'), manifest);
    appendJsonl(this.auditFile, auditEntry({
      id: randomUUID(),
      at: manifest.undoneAt,
      action: { id: null, type: 'undo', path: null, targetPath: null },
      plan: { version: manifest.planVersion ?? OPERATION_PLAN_VERSION, id: manifest.planId ?? manifest.id, actor, role, source },
      operationId: manifest.id,
      actor,
      role,
      source,
      status: 'completed',
    }));
    return { operationId: manifest.id, planId: manifest.planId ?? manifest.id, undone: true };
  }

  log(limit = 40) {
    if (!fs.existsSync(this.auditFile)) return [];
    const count = Math.min(Math.max(Number(limit) || 40, 1), 500);
    return fs.readFileSync(this.auditFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-count).reverse().flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }

  resolve(relativePath) {
    const safePath = normalizeRelativePath(relativePath);
    const resolved = path.resolve(this.rootDir, ...safePath.split('/'));
    assertInsideRoot(this.rootDir, resolved);
    assertNotInternal(safePath);
    assertNoSymlink(this.rootDir, resolved);
    return resolved;
  }

  resolveDirectory(relativePath = '') {
    const safePath = normalizeDirectoryPath(relativePath);
    const resolved = path.resolve(this.rootDir, ...safePath.split('/').filter(Boolean));
    assertInsideRoot(this.rootDir, resolved);
    assertNotInternal(safePath);
    assertNoSymlink(this.rootDir, resolved);
    if (fs.existsSync(resolved)) {
      if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${safePath || '.'}`);
      if (!fs.statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${safePath}`);
    }
    return resolved;
  }

  listFiles(baseDir = this.rootDir) {
    if (!fs.existsSync(baseDir)) return [];
    const files = [];
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (baseDir === this.rootDir && entry.name === INTERNAL_DIR) continue;
      const entryPath = path.join(baseDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...this.listFiles(entryPath));
      else if (entry.isFile()) files.push(entryPath);
    }
    return files.sort((left, right) => left.localeCompare(right));
  }

  findManifest(operationId) {
    if (operationId) return readManifest(path.join(this.trashDir, operationId, 'manifest.json'));
    if (!fs.existsSync(this.trashDir)) return null;
    const manifests = fs.readdirSync(this.trashDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readManifest(path.join(this.trashDir, entry.name, 'manifest.json')))
      .filter((manifest) => manifest && !manifest.undoneAt)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return manifests.at(-1) ?? null;
  }

  changePaths(action) {
    return action.type === 'move' ? [action.path, action.targetPath] : action.type === 'copy' ? [action.targetPath] : [action.path];
  }
}

export function createFileStore(rootDir) {
  return new FileStore(rootDir);
}

function normalizeAction(type, input) {
  const actionType = String(type ?? '').toLowerCase();
  if (!MUTATIONS.has(actionType)) throw new Error(`Unsupported mutation: ${actionType || '(empty)'}`);
  const action = { type: actionType, path: normalizeRelativePath(input.path ?? input.source) };
  if (['copy', 'move'].includes(actionType)) action.targetPath = normalizeRelativePath(input.targetPath ?? input.destination ?? input.to);
  if (['create', 'write', 'append'].includes(actionType)) {
    if (typeof input.content !== 'string') throw new Error(`${actionType} requires --content`);
    action.content = input.content;
  }
  if (actionType === 'edit') {
    if (typeof input.replace !== 'string' || !input.replace) throw new Error('edit requires --replace');
    if (typeof input.with !== 'string') throw new Error('edit requires --with');
    action.replace = input.replace;
    action.with = input.with;
    action.all = Boolean(input.all);
  }
  return action;
}

function normalizeBatchActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) throw new Error('Batch requires a non-empty actions array');
  return actions.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Batch action ${index + 1} must be an object`);
    try {
      return normalizeAction(input.type, input);
    } catch (error) {
      throw new Error(`Batch action ${index + 1}: ${error.message}`);
    }
  });
}

function applyAction(store, action) {
  const source = store.resolve(action.path);
  const target = action.targetPath ? store.resolve(action.targetPath) : null;
  if (action.type === 'mkdir') {
    if (fs.existsSync(source)) throw new Error(`Path already exists: ${action.path}`);
    assertWritablePath(store.rootDir, source);
    fs.mkdirSync(source, { recursive: true });
    return { path: action.path };
  }
  if (['create', 'write', 'append', 'edit'].includes(action.type)) {
    assertWritablePath(store.rootDir, source);
    if (action.type === 'create' && fs.existsSync(source)) throw new Error(`Path already exists: ${action.path}`);
    if (!['create', 'write'].includes(action.type)) assertRegularFile(source, action.path);
    const current = readTextIfPresent(source);
    const content = nextText(action, current);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    writeAtomic(source, content);
    return { path: action.path, size: Buffer.byteLength(content), replaced: action.type === 'edit' ? countOccurrences(current, action.replace) : undefined };
  }
  assertRegularFile(source, action.path);
  if (action.type === 'delete') {
    assertWritablePath(store.rootDir, source);
    fs.unlinkSync(source);
    return { path: action.path };
  }
  if (!target) throw new Error(`${action.type} requires a target path`);
  if (fs.existsSync(target)) throw new Error(`Target already exists: ${action.targetPath}`);
  assertWritablePath(store.rootDir, source);
  assertWritablePath(store.rootDir, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (action.type === 'copy') fs.copyFileSync(source, target);
  else fs.renameSync(source, target);
  return { fromPath: action.path, toPath: action.targetPath };
}

function nextText(action, current) {
  if (action.type === 'create' || action.type === 'write') return action.content;
  if (typeof current !== 'string') throw new Error(`Source file does not exist: ${action.path}`);
  if (action.type === 'append') return current + action.content;
  const matches = countOccurrences(current, action.replace);
  if (!matches) throw new Error(`Text to replace was not found in ${action.path}`);
  if (matches > 1 && !action.all) throw new Error(`Text to replace occurs ${matches} times; use --all to replace all`);
  return current.split(action.replace).join(action.with);
}

function captureEntry(rootDir, relativePath, snapshotDir, index) {
  const absolutePath = path.resolve(rootDir, ...relativePath.split('/'));
  const before = stateFor(absolutePath);
  const entry = { path: relativePath, before };
  if (before.type === 'file') {
    const snapshot = path.join(snapshotDir, `${index}.bin`);
    fs.copyFileSync(absolutePath, snapshot);
    entry.snapshot = path.basename(snapshot);
  }
  return entry;
}

function restoreEntry(rootDir, entry, operationDir) {
  const absolutePath = path.resolve(rootDir, ...entry.path.split('/'));
  assertInsideRoot(rootDir, absolutePath);
  assertWritablePath(rootDir, absolutePath);
  if (!entry.before.exists) {
    if (fs.existsSync(absolutePath)) {
      const current = fs.lstatSync(absolutePath);
      if (current.isDirectory()) {
        try {
          fs.rmdirSync(absolutePath);
        } catch (error) {
          if (['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error?.code)) throw new Error(`Cannot undo: directory is not empty (${entry.path})`);
          throw error;
        }
      } else {
        // On Windows, rmSync can report success while leaving a watched file behind.
        // unlinkSync is the reliable first path for regular files; fail loudly if both paths leave it in place.
        try {
          fs.unlinkSync(absolutePath);
        } catch (error) {
          if (error?.code === 'ENOENT') return;
          fs.rmSync(absolutePath, { force: true });
        }
        if (fs.existsSync(absolutePath)) throw new Error(`Cannot undo: file could not be removed (${entry.path})`);
      }
    }
    return;
  }
  if (entry.before.type === 'directory') {
    fs.mkdirSync(absolutePath, { recursive: true });
    return;
  }
  const snapshot = path.join(operationDir, 'files', entry.snapshot);
  if (!fs.existsSync(snapshot)) throw new Error(`Undo snapshot is missing: ${entry.path}`);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeAtomicFromFile(absolutePath, snapshot);
}

function stateFor(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${filePath}`);
    if (stat.isDirectory()) return { exists: true, type: 'directory' };
    if (!stat.isFile()) return { exists: true, type: 'other' };
    const data = fs.readFileSync(filePath);
    return { exists: true, type: 'file', size: stat.size, sha256: sha256(data) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, type: 'missing' };
    throw error;
  }
}

function stateForText(content) {
  const data = Buffer.from(content, 'utf8');
  return { exists: true, type: 'file', size: data.byteLength, sha256: sha256(data) };
}

function readTextIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stat.size > MAX_READ_BYTES) throw new Error(`File is too large: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
}

function assertRegularFile(filePath, displayPath) {
  if (!fs.existsSync(filePath)) throw new Error(`File does not exist: ${displayPath}`);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Not a regular file: ${displayPath}`);
}

function assertWritablePath(rootDir, absolutePath) {
  assertInsideRoot(rootDir, absolutePath);
  assertNoSymlink(rootDir, absolutePath);
}

function assertNoSymlink(rootDir, absolutePath) {
  let current = absolutePath;
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${path.relative(rootDir, current)}`);
    if (current === rootDir) break;
    current = path.dirname(current);
  }
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A relative path is required');
  const portable = value.trim().replaceAll('\\', '/');
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(portable)) throw new Error(`Absolute paths are not allowed: ${value}`);
  const parts = portable.split('/');
  if (parts.some((part) => part === '..')) throw new Error(`Path traversal is not allowed: ${value}`);
  const normalized = path.posix.normalize(portable);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`Invalid relative path: ${value}`);
  assertNotInternal(normalized);
  return normalized;
}

function normalizeDirectoryPath(value) {
  if (value === undefined || value === null || value === '' || value === '.') return '';
  return normalizeRelativePath(value);
}

function normalizePattern(value) {
  const pattern = String(value || '**/*').replaceAll('\\', '/');
  if (path.posix.isAbsolute(pattern) || path.win32.isAbsolute(pattern) || pattern.split('/').includes('..')) throw new Error(`Invalid search pattern: ${value}`);
  return pattern.replace(/^\.\//, '');
}

function assertInsideRoot(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path escapes root: ${targetPath}`);
}

function assertNotInternal(relativePath) {
  if (String(relativePath).split('/')[0] === INTERNAL_DIR) throw new Error(`The ${INTERNAL_DIR} directory is reserved`);
}

function toPortable(value) {
  return value.replaceAll('\\', '/');
}

function globToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'i');
}

function fileInfo(rootDir, filePath) {
  const stat = fs.statSync(filePath);
  return { path: toPortable(path.relative(rootDir, filePath)), size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

function fileStat(relativePath, filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${relativePath}`);
  if (stat.isDirectory()) return { path: relativePath, exists: true, type: 'directory', modifiedAt: stat.mtime.toISOString() };
  if (stat.isFile()) return { path: relativePath, exists: true, type: 'file', size: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: sha256(fs.readFileSync(filePath)) };
  return { path: relativePath, exists: true, type: 'other', modifiedAt: stat.mtime.toISOString() };
}

function describeAction(action, changes) {
  const destination = action.targetPath ? ` -> ${action.targetPath}` : '';
  const before = changes[0]?.before;
  const state = before?.exists ? '' : ' (source missing)';
  return `${action.type} ${action.path}${destination}${state}`;
}

function describeBatch(operations, counts) {
  const breakdown = Object.entries(counts).map(([type, count]) => `${count} ${type}`).join(', ');
  return `${operations.length} file operation${operations.length === 1 ? '' : 's'}${breakdown ? ` (${breakdown})` : ''}`;
}

function batchPlanHash(actions, operations) {
  const before = operations.map(({ type, path, targetPath, changes }) => ({ type, path, targetPath, changes }));
  return sha256(JSON.stringify({ actions, before }));
}

function singlePlanHash(action, changes) {
  return sha256(JSON.stringify({ version: OPERATION_PLAN_VERSION, action, changes }));
}

function assertPlanHash(expected, actual, message) {
  if (!expected || expected === actual) return;
  const error = new Error(`${message}: expected ${expected}, current ${actual}`);
  error.code = 'FC_PLAN_MISMATCH';
  throw error;
}

function previewPaths(action) {
  return action.type === 'move' || action.type === 'copy'
    ? [action.path, action.targetPath]
    : [action.path];
}

function countOccurrences(value, search) {
  return value.split(search).length - 1;
}

function unifiedDiff(filePath, before, after) {
  if (before === after) return '';
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  const lines = [`--- ${filePath}`, `+++ ${filePath}`];
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] === right[index]) continue;
    if (left[index] !== undefined) lines.push(`-${left[index]}`);
    if (right[index] !== undefined) lines.push(`+${right[index]}`);
  }
  return lines.join('\n');
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sameState(left, right) {
  return left?.exists === right?.exists && left?.type === right?.type && (!left?.exists || left.type !== 'file' || left.sha256 === right.sha256);
}

function writeAtomic(filePath, content) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    replaceFile(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function writeAtomicFromFile(filePath, sourcePath) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.copyFileSync(sourcePath, temporary);
    replaceFile(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function replaceFile(sourcePath, targetPath) {
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || !fs.existsSync(targetPath)) throw error;
    fs.rmSync(targetPath, { force: true });
    fs.renameSync(sourcePath, targetPath);
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function auditEntry({
  id,
  at,
  action,
  plan,
  operationId = null,
  batchId = null,
  actor = 'local-user',
  role = 'editor',
  source = 'fc',
  status,
  error = null,
}) {
  return {
    id,
    at,
    planVersion: plan?.version ?? OPERATION_PLAN_VERSION,
    planId: plan?.id ?? null,
    actor,
    role: plan?.role ?? role,
    source,
    status,
    type: action?.type ?? null,
    path: action?.path ?? null,
    targetPath: action?.targetPath ?? null,
    action: auditAction(action),
    ...(operationId ? { operationId } : {}),
    ...(batchId ? { batchId } : {}),
    ...(error ? { error } : {}),
  };
}

function readManifest(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // 文件缺失与 JSON 损坏同样按「没有可撤销的操作」处理；区分二者对调用方没有意义
    return null;
  }
}
