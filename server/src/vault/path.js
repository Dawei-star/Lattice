import path from 'node:path';

const WINDOWS_RESERVED = /[<>:"|?*\u0000]/;
const ILLEGAL_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
// Win32 保留设备名：CON.md 这类路径 Windows 上无法创建，需在词法层拦截
const RESERVED_DEVICE_NAMES = new Set(
  ['CON', 'PRN', 'AUX', 'NUL',
    ...Array.from({ length: 10 }, (_, i) => `COM${i}`),
    ...Array.from({ length: 10 }, (_, i) => `LPT${i}`)],
);

/**
 * Sanitize one path segment (file or folder name) for portable filesystem safety.
 * Strips every reserved char plus all control characters, and trailing dots/spaces.
 */
export function sanitizeFilePart(value, fallback = '未命名笔记') {
  const cleaned = String(value || fallback)
    .replace(ILLEGAL_FILE_CHARS, '_')
    .replace(/[. ]+$/g, '')
    .trim() || fallback;
  const stem = cleaned.includes('.') ? cleaned.slice(0, cleaned.indexOf('.')) : cleaned;
  if (RESERVED_DEVICE_NAMES.has(stem.toUpperCase())) return `_${cleaned}`;
  return cleaned;
}

/** Normalize a user-visible note path without allowing filesystem escape. */
export function normalizeVaultRelativePath(input, extension = '.md') {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('知识库路径不能为空');

  const normalized = input.trim().replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error('知识库内路径必须是相对路径');
  }

  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || WINDOWS_RESERVED.test(part))) {
    throw new Error('知识库路径包含非法片段');
  }

  const result = parts.join('/');
  return result.endsWith(extension) ? result : `${result}${extension}`;
}

export function resolveVaultPath(vaultDir, relativePath, extension = '.md') {
  const safeRelative = normalizeVaultRelativePath(relativePath, extension);
  const root = path.resolve(vaultDir);
  const target = path.resolve(root, safeRelative);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('知识库路径越界');
  }
  return target;
}
