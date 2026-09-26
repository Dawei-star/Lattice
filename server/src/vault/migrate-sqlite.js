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
    'SELECT id, title, content, folder_id, is_pinned, created_at, updated_at FROM notes ORDER BY updated_at ASC',
  ).all();
  const adapter = new VaultAdapter(vaultDir);
  await adapter.ensure();

  const migrated = [];
  const skipped = [];
  const conflicts = [];

  for (const row of notes) {
    const folderPath = getFolderPath(row.folder_id, folderMap);
    const filePath = normalizeVaultRelativePath(path.posix.join(folderPath, safeFileName(row.title)));
    const absolutePath = resolveVaultPath(vaultDir, filePath);

    try {
      const existing = await adapter.read(filePath);
      if (existing.id === row.id) {
        skipped.push({ id: row.id, filePath, reason: 'already-migrated' });
      } else {
        conflicts.push({ id: row.id, filePath, reason: 'file-exists' });
      }
      continue;
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
    migrated.push({ id: row.id, filePath });
  }

  return { migrated, skipped, conflicts, total: notes.length, vaultDir };
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
