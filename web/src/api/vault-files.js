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
};

export const vaultAssetsApi = {
  list: () => http.get('/vault/assets'),
};

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
