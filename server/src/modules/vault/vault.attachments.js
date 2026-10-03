import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { parseMarkdownDocument } from '../../vault/markdown.js';
import { normalizeVaultRelativePath, resolveVaultPath, sanitizeFilePart } from '../../vault/path.js';
import { VaultAdapter } from '../../vault/vault.adapter.js';

export const ATTACHMENT_ROOT = 'attachments';
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

const MIME_BY_EXTENSION = new Map([
  ['.avif', 'image/avif'],
  ['.csv', 'text/csv'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

const MIME_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['audio/x-wav', 'audio/wav'],
  ['application/octet-stream', null],
]);

const ATTACHMENT_REFERENCE_RE = /!?(?:\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))[^)]*\)|\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]|(?:src|href)\s*=\s*["']([^"']+)["'])/gi;
const WIKI_EMBED_RE = /!\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/gi;

/** List uploaded files and their current Markdown reference state. */
export function listAttachments() {
  const rootDir = config.vaultDir;
  const referenceMap = collectReferenceMap(rootDir);
  return listAttachmentFiles(rootDir).map((file) => ({
    ...file,
    referencedBy: referenceMap.get(file.path) ?? [],
    orphan: !referenceMap.has(file.path),
  }));
}

const NOTE_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.canvas']);
const IGNORED_VAULT_DIRECTORY_NAMES = new Set(['node_modules']);

/**
 * 列出整个 Vault 中除笔记 / 画布之外的所有文件（「显示附件」开关使用）。
 * 与 listAttachments 不同，这里不限于 attachments/ 目录——用户可能把
 * docx、PDF 等文件直接放在笔记文件夹里（Obsidian「检测所有文件扩展名」
 * 的行为）。隐藏目录与临时文件不参与。
 */
export function listVaultFiles() {
  const rootDir = config.vaultDir;
  const result = [];
  walkVaultFiles(rootDir, rootDir, '', result);
  return result.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
}

function walkVaultFiles(rootDir, absoluteDir, relativeDir, result) {
  let entries;
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    // 目录可能刚被删除或暂时无权限，跳过而不是让整次列举失败
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue;
    if (IGNORED_VAULT_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const absolutePath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      walkVaultFiles(rootDir, absolutePath, relativePath, result);
      continue;
    }
    if (!entry.isFile()) continue;
    if (NOTE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    // stat 可能因文件恰好被删除而失败，跳过单项而不是让整次列举 500
    try {
      result.push(getVaultFileInfo(rootDir, relativePath));
    } catch {
      // 忽略瞬时消失的文件
    }
  }
}

function getVaultFileInfo(rootDir, relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const stat = fs.statSync(resolveVaultPath(rootDir, normalized, ''));
  return {
    path: normalized,
    name: path.posix.basename(normalized),
    mimeType: MIME_BY_EXTENSION.get(path.extname(normalized).toLowerCase()) ?? null,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

export function uploadAttachment({ name, mimeType, body, folder = '' }) {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new ValidationError('附件内容不能为空');
  }
  if (body.length > MAX_ATTACHMENT_SIZE) {
    throw new ValidationError('附件不能超过 25 MB');
  }

  const originalName = path.posix.basename(String(name ?? '').replaceAll('\\', '/')).trim();
  const safeName = sanitizeFilePart(originalName, 'attachment');
  const extension = path.extname(safeName).toLowerCase();
  const expectedMime = MIME_BY_EXTENSION.get(extension);
  if (!expectedMime) {
    throw new ValidationError('不支持的附件格式', [{ in: 'query', field: 'name', message: '仅支持常见图片、文档、音视频附件' }]);
  }

  const declaredMime = normalizeMime(mimeType);
  if (declaredMime && declaredMime !== expectedMime) {
    throw new ValidationError('附件类型与文件扩展名不匹配', [{ in: 'header', field: 'content-type', message: `${extension} 应使用 ${expectedMime}` }]);
  }

  const rootDir = config.vaultDir;
  const relativePath = allocateAttachmentPath(rootDir, safeName, folder);
  const target = resolveVaultPath(rootDir, relativePath, '');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, body, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }

  return getAttachmentInfo(rootDir, relativePath, expectedMime);
}

export function readAttachment(relativePath) {
  const safePath = assertAttachmentPath(relativePath);
  const rootDir = config.vaultDir;
  const target = resolveInsideVault(rootDir, safePath);
  if (!target) return null;

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) return null;

  return {
    ...getAttachmentInfo(rootDir, safePath),
    absolutePath: target,
  };
}

export function getAttachmentReferences(relativePath) {
  const safePath = assertAttachmentPath(relativePath);
  const references = collectReferenceMap(config.vaultDir).get(safePath) ?? [];
  return { path: safePath, referenced: references.length > 0, referencedBy: references };
}

export function validateReferences({ content = '', filePath = '' } = {}) {
  const references = extractAttachmentReferences(content, filePath, config.vaultDir);
  const existing = new Set(listAttachmentFiles(config.vaultDir).map((file) => file.path));
  return {
    references,
    missing: references.filter((reference) => !existing.has(reference)),
  };
}

export function deleteAttachment(relativePath) {
  const safePath = assertAttachmentPath(relativePath);
  const target = resolveInsideVault(config.vaultDir, safePath);
  if (!target || !fs.existsSync(target)) throw new NotFoundError('附件不存在');

  const references = collectReferenceMap(config.vaultDir).get(safePath) ?? [];
  if (references.length > 0) {
    throw new ConflictError('附件仍被笔记引用，请先移除引用后再删除', {
      details: { path: safePath, referencedBy: references },
    });
  }

  fs.unlinkSync(target);
  removeEmptyParents(config.vaultDir, path.posix.dirname(safePath));
  return { path: safePath, deleted: true };
}

export function cleanupOrphans({ dryRun = true } = {}) {
  const files = listAttachmentFiles(config.vaultDir);
  const referenceMap = collectReferenceMap(config.vaultDir);
  const candidates = files.filter((file) => !referenceMap.has(file.path));
  if (dryRun) {
    return { dryRun: true, candidates, deleted: [], skipped: [] };
  }

  const deleted = [];
  const skipped = [];
  for (const candidate of candidates) {
    const references = referenceMap.get(candidate.path) ?? [];
    if (references.length > 0) {
      skipped.push({ ...candidate, referencedBy: references });
      continue;
    }
    const target = resolveInsideVault(config.vaultDir, candidate.path);
    if (!target || !fs.existsSync(target)) continue;
    fs.unlinkSync(target);
    deleted.push(candidate.path);
  }
  removeEmptyParents(config.vaultDir, ATTACHMENT_ROOT);
  return { dryRun: false, candidates, deleted, skipped };
}

export function extractAttachmentReferences(content, filePath = '', rootDir = config.vaultDir) {
  const source = stripCode(content);
  const rawReferences = [];
  for (const match of source.matchAll(ATTACHMENT_REFERENCE_RE)) {
    rawReferences.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
  for (const match of source.matchAll(WIKI_EMBED_RE)) rawReferences.push(match[1]);

  const result = [];
  const seen = new Set();
  for (const raw of rawReferences) {
    const reference = resolveAttachmentReference(raw, filePath, rootDir);
    if (!reference || seen.has(reference)) continue;
    seen.add(reference);
    result.push(reference);
  }
  return result;
}

function collectReferenceMap(rootDir) {
  const map = new Map();
  const adapter = new VaultAdapter(rootDir);
  for (const filePath of adapter.listMarkdownPaths()) {
    let raw;
    try {
      raw = fs.readFileSync(resolveVaultPath(rootDir, filePath, ''), 'utf8');
    } catch {
      continue;
    }
    const document = parseMarkdownDocument(raw, filePath);
    for (const attachmentPath of extractAttachmentReferences(document.content, filePath, rootDir)) {
      const entries = map.get(attachmentPath) ?? [];
      entries.push({ filePath, title: document.title });
      map.set(attachmentPath, entries);
    }
  }
  return map;
}

function listAttachmentFiles(rootDir) {
  const base = resolveVaultPath(rootDir, ATTACHMENT_ROOT, '');
  const result = [];
  walkAttachmentFiles(rootDir, base, ATTACHMENT_ROOT, result);
  return result.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
}

function walkAttachmentFiles(rootDir, absoluteDir, relativeDir, result) {
  if (!fs.existsSync(absoluteDir)) return;
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue;
    const relativePath = `${relativeDir}/${entry.name}`.replaceAll('\\', '/');
    const absolutePath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      walkAttachmentFiles(rootDir, absolutePath, relativePath, result);
      continue;
    }
    if (!entry.isFile() || !MIME_BY_EXTENSION.has(path.extname(entry.name).toLowerCase())) continue;
    result.push(getAttachmentInfo(rootDir, relativePath));
  }
}

function getAttachmentInfo(rootDir, relativePath, mimeType = null) {
  const safePath = assertAttachmentPath(relativePath);
  const target = resolveInsideVault(rootDir, safePath);
  if (!target) throw new NotFoundError('附件不存在');
  const stat = fs.statSync(target);
  return {
    path: safePath,
    name: path.posix.basename(safePath),
    mimeType: mimeType ?? MIME_BY_EXTENSION.get(path.extname(safePath).toLowerCase()),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

/** 附件子目录：逐段清洗（每段仍走文件名清洗规则），限制深度与长度，空结果是合法值（直接放 attachments 根）。 */
function sanitizeAttachmentFolder(folder) {
  const segments = String(folder ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => sanitizeFilePart(segment, '').trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..' && !segment.startsWith('.'));
  return segments.slice(0, 4).join('/').slice(0, 200);
}

function allocateAttachmentPath(rootDir, name, folder = '') {
  const extension = path.posix.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  const directory = sanitizeAttachmentFolder(folder);
  const base = directory ? `${ATTACHMENT_ROOT}/${directory}` : ATTACHMENT_ROOT;
  let candidate = `${base}/${name}`;
  let suffix = 2;
  while (fs.existsSync(resolveVaultPath(rootDir, candidate, ''))) {
    candidate = `${base}/${stem} (${suffix})${extension}`;
    suffix += 1;
  }
  return candidate;
}

function assertAttachmentPath(relativePath) {
  let safePath;
  try {
    safePath = normalizeVaultRelativePath(relativePath, '');
  } catch {
    throw new ValidationError('附件路径必须是 Vault 内的相对路径');
  }
  if (safePath === ATTACHMENT_ROOT || !safePath.startsWith(`${ATTACHMENT_ROOT}/`)) {
    throw new ValidationError('附件路径必须位于 attachments 目录');
  }
  const extension = path.extname(safePath).toLowerCase();
  if (!MIME_BY_EXTENSION.has(extension)) throw new ValidationError('不支持的附件格式');
  return safePath;
}

function resolveInsideVault(rootDir, relativePath) {
  const target = resolveVaultPath(rootDir, relativePath, '');
  let root;
  let real;
  try {
    root = fs.realpathSync(rootDir);
    real = fs.realpathSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (!relative.replaceAll('\\', '/').startsWith(`${ATTACHMENT_ROOT}/`)) return null;
  return real;
}

function resolveAttachmentReference(rawReference, notePath, rootDir) {
  if (typeof rawReference !== 'string') return null;
  let reference = rawReference.trim();
  if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return null;
  try {
    reference = decodeURIComponent(reference);
  } catch {
    return null;
  }
  reference = reference.replaceAll('\\', '/').split('#')[0].split('?')[0].trim();
  if (!reference || path.posix.extname(reference) === '') return null;

  const noteDir = notePath ? path.posix.dirname(notePath) : '';
  const rootReference = normalizeReference(reference);
  const relativeReference = normalizeReference(path.posix.join(noteDir, reference));
  const candidates = reference.startsWith(`${ATTACHMENT_ROOT}/`) || reference.startsWith('/')
    ? [rootReference, relativeReference]
    : [relativeReference, rootReference];
  for (const candidate of candidates) {
    if (!candidate?.startsWith(`${ATTACHMENT_ROOT}/`)) continue;
    if (fs.existsSync(resolveVaultPath(rootDir, candidate, ''))) return candidate;
  }
  return candidates.find((candidate) => candidate?.startsWith(`${ATTACHMENT_ROOT}/`)) ?? null;
}

function normalizeReference(value) {
  const normalized = String(value ?? '').replace(/^\/+/, '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) return null;
  const result = path.posix.normalize(normalized);
  if (result === '.' || result.startsWith('../') || result.includes('/../')) return null;
  return result;
}

function stripCode(source) {
  return String(source ?? '')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}

function normalizeMime(value) {
  const mime = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return MIME_ALIASES.has(mime) ? MIME_ALIASES.get(mime) : mime || null;
}

function removeEmptyParents(rootDir, relativeDir) {
  let current = path.resolve(rootDir, relativeDir);
  const stop = path.resolve(rootDir, ATTACHMENT_ROOT);
  while (current !== stop && current.startsWith(`${stop}${path.sep}`)) {
    try {
      if (fs.readdirSync(current).length > 0) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}
