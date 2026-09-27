import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeVaultRelativePath, resolveVaultPath } from '../../vault/path.js';

const IMAGE_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

/**
 * Return image files without exposing absolute Vault paths to the caller.
 * Hidden folders and the internal index directory are intentionally skipped.
 */
export async function listImageFiles(rootDir) {
  const files = [];
  await walkImages(rootDir, '', files);
  return files.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
}

export async function getImageFile(rootDir, relativePath) {
  const safePath = normalizeVaultRelativePath(relativePath, '');
  const type = imageType(safePath);
  if (!type) return null;

  let root;
  let target;
  try {
    root = await fs.realpath(rootDir);
    target = await fs.realpath(resolveVaultPath(rootDir, safePath, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  const stat = await fs.stat(target);
  if (!stat.isFile()) return null;
  return { path: safePath, absolutePath: target, mimeType: type, size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

async function walkImages(rootDir, relativeDir, result) {
  const absoluteDir = path.join(rootDir, relativeDir);
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.name === '.lattice' || entry.name.startsWith('.')) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkImages(rootDir, relativePath, result);
      continue;
    }
    if (!entry.isFile()) continue;
    const mimeType = imageType(relativePath);
    if (!mimeType) continue;
    const stat = await fs.stat(path.join(rootDir, relativePath));
    result.push({
      path: relativePath.replaceAll('\\', '/'),
      name: entry.name,
      mimeType,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
}

function imageType(relativePath) {
  return IMAGE_TYPES.get(path.extname(relativePath).toLowerCase()) ?? null;
}
