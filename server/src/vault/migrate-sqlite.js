import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '../db/index.js';
import { VaultAdapter } from './vault.adapter.js';
import { normalizeVaultRelativePath, resolveVaultPath } from './path.js';

export async function migrateSqliteToVault(vaultDir) {
  const db = getDb();
  const folders = db.prepare('SELECT id, name, parent_id FROM folders').all();
  const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
  const notes = db.prepare(
    'SELECT id, title, content, folder_id, file_path, is_pinned, created_at, updated_at FROM notes ORDER BY updated_at ASC',
  ).all();
  const adapter = new VaultAdapter(vaultDir);
  await adapter.ensure();

  const migrated = [];
  const skipped = [];
  const conflicts = [];

  for (const row of notes) {
    const folderPath = getFolderPath(row.folder_id, folderMap);
    const basePath = row.file_path || normalizeVaultRelativePath(path.posix.join(folderPath, safeFileName(row.title)));
    const filePath = await allocateMigrationPath(db, adapter, basePath, row.id);
    const absolutePath = resolveVaultPath(vaultDir, filePath);

    try {
      const existing = await adapter.read(filePath);
      if (existing.id === row.id) {
        skipped.push({ id: row.id, filePath, reason: 'already-migrated' });
        db.prepare('UPDATE notes SET file_path = ? WHERE id = ?').run(filePath, row.id);
      } else {
        conflicts.push({ id: row.id, filePath, reason: 'file-renamed-to-avoid-conflict' });
      }
      if (existing.id === row.id) continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await adapter.write({
      id: row.id,
      title: row.title,
      content: row.content,
      filePath,
      isPinned: row.is_pinned === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    db.prepare('UPDATE notes SET file_path = ? WHERE id = ?').run(filePath, row.id);
    migrated.push({ id: row.id, filePath });
  }

  return { migrated, skipped, conflicts, total: notes.length, vaultDir };
}

async function allocateMigrationPath(db, adapter, basePath, noteId) {
  const extension = '.md';
  const stem = basePath.endsWith(extension) ? basePath.slice(0, -extension.length) : basePath;
  let candidate = basePath;
  let suffix = 2;
  while (true) {
    const owner = db.prepare('SELECT id FROM notes WHERE file_path = ?').get(candidate);
    if (!owner || owner.id === noteId) {
      if (!adapter.existsSync(candidate)) return candidate;
      try {
        const existing = await adapter.read(candidate);
        if (existing.id === noteId) return candidate;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    candidate = `${stem} (${suffix})${extension}`;
    suffix += 1;
  }
}

function getFolderPath(folderId, folderMap) {
  const parts = [];
  const visited = new Set();
  let current = folderId ? folderMap.get(folderId) : null;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    parts.unshift(safeFileName(current.name));
    current = current.parent_id ? folderMap.get(current.parent_id) : null;
  }
  return parts.join('/');
}

export function safeFileName(value) {
  return String(value || '未命名笔记')
    .replace(/[<>:"/\\|?*\u0000]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || '未命名笔记';
}
