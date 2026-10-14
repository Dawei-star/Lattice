import { BASE_URL, http, type RequestOptions } from './client.ts';
import { workspaceHeaders } from './workspace-auth.ts';
import type { FolderNode, NoteProperties } from './resources.ts';

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** 写文件确认载荷（高风险操作的二次确认结果）。 */
export type FileConfirmation = Record<string, unknown>;

/** window.latticeDesktop 注入的桌面端文件桥（桌面壳环境提供，浏览器环境缺失）。 */
export interface LatticeDesktopBridge {
  readMarkdownFile(filePath: string): Promise<string | null>;
  writeMarkdownFile(filePath: string, raw: string, confirmation: FileConfirmation): Promise<unknown>;
  moveMarkdownFile(fromPath: string, toPath: string, raw: string, confirmation: FileConfirmation): Promise<unknown>;
  removeMarkdownFile(filePath: string, confirmation: FileConfirmation): Promise<unknown>;
}

declare global {
  interface Window {
    latticeDesktop: LatticeDesktopBridge;
  }
}

/** 写盘用的笔记元数据（frontmatter 序列化输入）。 */
export interface NoteFileMeta {
  id: string;
  title: string;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  folderId?: string | null;
  properties?: NoteProperties;
  content?: string;
}

/** 文件路径计算所需的笔记字段。 */
export type NotePathSource = Pick<NoteFileMeta, 'title'> & { id?: string; folderId?: string | null };

export const vaultFiles = {
  isAvailable: (): boolean => typeof window.latticeDesktop?.readMarkdownFile === 'function',
  async readMarkdown(filePath: string): Promise<string | null> {
    const raw = await window.latticeDesktop.readMarkdownFile(filePath);
    if (raw === null) return null;
    return raw.replace(FRONTMATTER_RE, '');
  },
  writeMarkdown(filePath: string, note: NoteFileMeta, confirmation: FileConfirmation = {}): Promise<unknown> {
    return writeMarkdownContent(filePath, note, confirmation);
  },
  moveMarkdown(fromPath: string, toPath: string, note: NoteFileMeta, confirmation: FileConfirmation = {}): Promise<unknown> {
    return window.latticeDesktop.moveMarkdownFile(fromPath, toPath, writeMarkdownContentValue(note), confirmation);
  },
  removeMarkdown(filePath: string, confirmation: FileConfirmation = {}): Promise<unknown> {
    return window.latticeDesktop.removeMarkdownFile(filePath, confirmation);
  },
  assetUrl(filePath: string): string {
    const url = new URL(`${BASE_URL}/vault/asset`, window.location.origin);
    url.searchParams.set('path', filePath);
    return url.toString();
  },
  attachmentUrl(filePath: string): string {
    const url = new URL(`${BASE_URL}/vault/attachment`, window.location.origin);
    url.searchParams.set('path', filePath);
    return url.toString();
  },
  downloadUrl(filePath: string): string {
    const url = new URL(`${BASE_URL}/vault/download`, window.location.origin);
    url.searchParams.set('path', filePath);
    return url.toString();
  },
  async download(filePath: string): Promise<void> {
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

/** Vault 内图片资源条目（GET /vault/assets）。 */
export interface VaultAssetSummary {
  path: string;
  name?: string;
  [key: string]: unknown;
}

export const vaultAssetsApi = {
  list: (): Promise<VaultAssetSummary[]> => http.get<VaultAssetSummary[]>('/vault/assets'),
};

/** Vault 附件条目。 */
export interface VaultAttachmentSummary {
  path: string;
  name?: string;
  [key: string]: unknown;
}

export const vaultAttachmentsApi = {
  list: (): Promise<VaultAttachmentSummary[]> => http.get<VaultAttachmentSummary[]>('/vault/attachments'),
  /** 全库扫描的非笔记文件（含 attachments/ 之外的任意文件夹），旧版后端没有该接口 */
  listAll: (): Promise<VaultAttachmentSummary[]> => http.get<VaultAttachmentSummary[]>('/vault/files'),
  upload: async (file: File, options: RequestOptions = {}): Promise<VaultAttachmentSummary | undefined> => {
    const payload = await http.postRaw<{ data?: VaultAttachmentSummary }>('/vault/attachments', file, {
      ...options,
      query: { ...(options.query ?? {}), name: file?.name },
      headers: { 'Content-Type': file?.type || 'application/octet-stream', ...(options.headers ?? {}) },
      timeout: options.timeout ?? 60_000,
      retries: options.retries ?? 0,
    });
    return payload?.data;
  },
  references: (path: string, options: RequestOptions = {}): Promise<unknown> => http.get('/vault/attachments/references', { ...options, query: { path } }),
  validate: (body: unknown, options: RequestOptions = {}): Promise<unknown> => http.post('/vault/attachments/validate', body, options),
  remove: (path: string, options: RequestOptions = {}): Promise<unknown> => http.delete('/vault/attachments', { ...options, query: { path } }),
  cleanup: (body: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<unknown> => http.post('/vault/attachments/cleanup', body, options),
};

/** Resolve an attachment reference relative to a note, with root-relative attachments support. */
export function resolveAttachmentPath(notePath: string | null | undefined, reference: string): string | null {
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
export function relativeAttachmentReference(notePath: string, attachmentPath: string): string {
  const noteDir = String(notePath ?? '').split('/').slice(0, -1).filter(Boolean);
  const target = String(attachmentPath ?? '').split('/').filter(Boolean);
  let common = 0;
  while (common < noteDir.length && common < target.length && noteDir[common] === target[common]) common += 1;
  const parts = [...Array(noteDir.length - common).fill('..'), ...target.slice(common)];
  return parts.join('/') || target.join('/');
}

/** Markdown 链接的 URL 引用：encodeURI 不编码 ( ) [ ]，文件名含括号时会生成解析失败的链接 */
export function encodeMarkdownUrlReference(reference: string): string {
  return encodeURI(reference)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\[/g, '%5B')
    .replace(/\]/g, '%5D');
}

/** Markdown 链接显示文本：剔除会破坏链接语法的中括号与圆括号 */
export function markdownLinkLabel(value: string): string {
  return String(value ?? '').replace(/[[\]()]/g, '').trim() || '附件';
}

function writeMarkdownContent(filePath: string, note: NoteFileMeta, confirmation: FileConfirmation = {}): Promise<unknown> {
  return window.latticeDesktop.writeMarkdownFile(filePath, writeMarkdownContentValue(note), confirmation);
}

function writeMarkdownContentValue(note: NoteFileMeta): string {
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

export function noteFilePath(note: NotePathSource, folders: FolderNode[]): string {
  const folderParts: string[] = [];
  const byId = new Map<string, FolderNode>();
  for (const root of folders ?? []) collectFolders(root, byId);
  let current = note.folderId ? byId.get(note.folderId) : null;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    folderParts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  const directory = folderParts.filter(Boolean).map(safeFilePart).join('/');
  return `${directory ? `${directory}/` : ''}${safeFilePart(note.title)}.md`;
}

function serializeProperties(properties: unknown): string[] {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.keys(properties)
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_-]{0,80}$/.test(key)
      && !['id', 'title', 'pinned', 'created_at', 'updated_at'].includes(key))
    .sort()
    .map((key) => `${key}: ${serializePropertyValue((properties as Record<string, unknown>)[key])}`);
}

function serializePropertyValue(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => serializePropertyValue(item)));
  return String(value ?? '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
}

export function uniqueNoteFilePath(note: NotePathSource, folders: FolderNode[], existingNotes: Array<{ id?: string; filePath?: string }> = []): string {
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

function collectFolders(node: FolderNode, byId: Map<string, FolderNode>): void {
  byId.set(node.id, node);
  for (const child of node.children ?? []) collectFolders(child, byId);
}

function safeFilePart(value: string): string {
  return String(value || '未命名笔记').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim() || '未命名笔记';
}

function normalizePath(parts: string[]): string | null {
  const stack: string[] = [];
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
