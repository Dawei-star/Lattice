import { BASE_URL, http } from './client.js';

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export const vaultFiles = {
  isAvailable: () => typeof window.latticeDesktop?.readMarkdownFile === 'function',
  async readMarkdown(filePath) {
    const raw = await window.latticeDesktop.readMarkdownFile(filePath);
    if (raw === null) return null;
    return raw.replace(FRONTMATTER_RE, '');
  },
  writeMarkdown(filePath, note) {
    return writeMarkdownContent(filePath, note);
  },
  moveMarkdown(fromPath, toPath, note) {
    return window.latticeDesktop.moveMarkdownFile(fromPath, toPath, writeMarkdownContentValue(note));
  },
  removeMarkdown(filePath) {
    return window.latticeDesktop.removeMarkdownFile(filePath);
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
};

export const vaultAssetsApi = {
  list: () => http.get('/vault/assets'),
};

export const vaultAttachmentsApi = {
  list: () => http.get('/vault/attachments'),
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

function writeMarkdownContent(filePath, note) {
  return window.latticeDesktop.writeMarkdownFile(filePath, writeMarkdownContentValue(note));
}

function writeMarkdownContentValue(note) {
    const frontmatter = [
      '---',
      `id: ${note.id}`,
      `title: ${note.title}`,
      `pinned: ${note.isPinned ? 'true' : 'false'}`,
      `created_at: ${note.createdAt}`,
      `updated_at: ${note.updatedAt}`,
      '---',
      '',
    ].join('\n');
    return `${frontmatter}${note.content ?? ''}`;
}

export function noteFilePath(note, folders) {
  const folderParts = [];
  const byId = new Map();
  for (const root of folders ?? []) collectFolders(root, byId, folderParts);
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
