import { BASE_URL, http } from './client.js';
import { workspaceHeaders } from './workspace-auth.js';

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export const vaultFiles = {
  isAvailable: () => typeof window.latticeDesktop?.readMarkdownFile === 'function',
  async readMarkdown(filePath) {
    const raw = await window.latticeDesktop.readMarkdownFile(filePath);
    if (raw === null) return null;
    return raw.replace(FRONTMATTER_RE, '');
  },
  writeMarkdown(filePath, note, confirmation = {}) {
    return writeMarkdownContent(filePath, note, confirmation);
  },
  moveMarkdown(fromPath, toPath, note, confirmation = {}) {
    return window.latticeDesktop.moveMarkdownFile(fromPath, toPath, writeMarkdownContentValue(note), confirmation);
  },
  removeMarkdown(filePath, confirmation = {}) {
    return window.latticeDesktop.removeMarkdownFile(filePath, confirmation);
  },
  assetUrl(filePath) {
    const url = new URL(`${BASE_URL}/vault/asset`, window.location.origin);
    url.searchParams.set('path', filePath);
    return url.toString();
  },
  attachmentUrl(filePath) {
    const url = new URL(`${BASE_URL}/vault/attachment`, window.location.origin);
    url.searchParams.set('path', filePath);
    return url.toString();
  },
  downloadUrl(filePath) {
    const url = new URL(`${BASE_URL}/vault/download`, window.location.origin);
    url.searchParams.set('path', filePath);
    return url.toString();
  },
  async download(filePath) {
    const response = await fetch(this.downloadUrl(filePath), { headers: workspaceHeaders() });
    if (!response.ok) throw new Error(`文件下载失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = String(filePath).replaceAll('\\', '/').split('/').pop() || 'download';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  },
};

export const vaultAssetsApi = {
  list: () => http.get('/vault/assets'),
};

export const vaultAttachmentsApi = {
  list: () => http.get('/vault/attachments'),
  /** 全库扫描的非笔记文件（含 attachments/ 之外的任意文件夹），旧版后端没有该接口 */
  listAll: () => http.get('/vault/files'),
  upload: async (file, options = {}) => {
    const payload = await http.postRaw('/vault/attachments', file, {
      ...options,
      query: { ...(options.query ?? {}), name: file?.name },
      headers: { 'Content-Type': file?.type || 'application/octet-stream', ...(options.headers ?? {}) },
      timeout: options.timeout ?? 60_000,
      retries: options.retries ?? 0,
    });
    return payload?.data;
  },
  references: (path, options = {}) => http.get('/vault/attachments/references', { ...options, query: { path } }),
  validate: (body, options = {}) => http.post('/vault/attachments/validate', body, options),
  remove: (path, options = {}) => http.delete('/vault/attachments', { ...options, query: { path } }),
  cleanup: (body = {}, options = {}) => http.post('/vault/attachments/cleanup', body, options),
};

/** Resolve an attachment reference relative to a note, with root-relative attachments support. */
export function resolveAttachmentPath(notePath, reference) {
  let value = String(reference ?? '').trim();
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  value = value.replaceAll('\\', '/').replace(/^\/+/, '').split('#')[0].split('?')[0];
  const relative = normalizePath([
    ...String(notePath ?? '').split('/').slice(0, -1),
    ...value.split('/'),
  ]);
  const root = normalizePath(value.split('/'));
  const candidates = value.startsWith('attachments/') ? [root, relative] : [relative, root];
  return candidates.find((candidate) => candidate?.startsWith('attachments/')) ?? null;
}

/** Produce a Markdown path that remains correct when the note is inside a folder. */
export function relativeAttachmentReference(notePath, attachmentPath) {
  const noteDir = String(notePath ?? '').split('/').slice(0, -1).filter(Boolean);
  const target = String(attachmentPath ?? '').split('/').filter(Boolean);
  let common = 0;
  while (common < noteDir.length && common < target.length && noteDir[common] === target[common]) common += 1;
  const parts = [...Array(noteDir.length - common).fill('..'), ...target.slice(common)];
  return parts.join('/') || target.join('/');
}

/** Markdown 链接的 URL 引用：encodeURI 不编码 ( ) [ ]，文件名含括号时会生成解析失败的链接 */
export function encodeMarkdownUrlReference(reference) {
  return encodeURI(reference)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\[/g, '%5B')
    .replace(/\]/g, '%5D');
}

/** Markdown 链接显示文本：剔除会破坏链接语法的中括号与圆括号 */
export function markdownLinkLabel(value) {
  return String(value ?? '').replace(/[[\]()]/g, '').trim() || '附件';
}

function writeMarkdownContent(filePath, note, confirmation = {}) {
  return window.latticeDesktop.writeMarkdownFile(filePath, writeMarkdownContentValue(note), confirmation);
}

function writeMarkdownContentValue(note) {
    const frontmatter = [
      '---',
      `id: ${note.id}`,
      `title: ${note.title}`,
      `pinned: ${note.isPinned ? 'true' : 'false'}`,
      `created_at: ${note.createdAt}`,
      `updated_at: ${note.updatedAt}`,
      ...serializeProperties(note.properties),
      '---',
      '',
    ].join('\n');
    return `${frontmatter}${note.content ?? ''}`;
}

export function noteFilePath(note, folders) {
  const folderParts = [];
  const byId = new Map();
  for (const root of folders ?? []) collectFolders(root, byId);
  let current = note.folderId ? byId.get(note.folderId) : null;
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    folderParts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  const directory = folderParts.filter(Boolean).map(safeFilePart).join('/');
  return `${directory ? `${directory}/` : ''}${safeFilePart(note.title)}.md`;
}

function serializeProperties(properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.keys(properties)
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_-]{0,80}$/.test(key)
      && !['id', 'title', 'pinned', 'created_at', 'updated_at'].includes(key))
    .sort()
    .map((key) => `${key}: ${serializePropertyValue(properties[key])}`);
}

function serializePropertyValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => serializePropertyValue(item)));
  return String(value ?? '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
}

export function uniqueNoteFilePath(note, folders, existingNotes = []) {
  const base = noteFilePath(note, folders);
  const extension = '.md';
  const stem = base.slice(0, -extension.length);
  const occupied = new Set(
    existingNotes
      .filter((candidate) => candidate?.id !== note?.id)
      .map((candidate) => candidate?.filePath)
      .filter(Boolean),
  );
  let candidate = base;
  let suffix = 2;
  while (occupied.has(candidate)) {
    candidate = `${stem} (${suffix})${extension}`;
    suffix += 1;
  }
  return candidate;
}

function collectFolders(node, byId) {
  byId.set(node.id, node);
  for (const child of node.children ?? []) collectFolders(child, byId);
}

function safeFilePart(value) {
  return String(value || '未命名笔记').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim() || '未命名笔记';
}

function normalizePath(parts) {
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}
