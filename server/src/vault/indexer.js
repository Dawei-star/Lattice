import { randomUUID } from 'node:crypto';
import { getDb, withTransaction } from '../db/index.js';
import { computeWordCount, extractTags } from '../lib/markdown.js';
import { nowIso } from '../lib/time.js';
import { rebuildForNote } from '../modules/links/links.service.js';
import { pruneOrphans as pruneOrphanTags, syncForNote } from '../modules/tags/tags.service.js';

/**
 * 全量重建投影（兜底路径）。
 *
 * 常规运行使用 sync.js 的增量引擎；本函数保留为「整库推倒重来」的一致性后盾，
 * 供未来「重建索引」维护动作使用。文件夹按路径复用既有 id，标签不再整体删除
 * 而是重建后清理孤儿——前端的 folderId / tagId 跨重建保持稳定。
 */
export function rebuildProjection(notes, { folderPaths = [] } = {}) {
  return withTransaction(() => {
    const db = getDb();
    const previousFolders = db.prepare('SELECT id, name, parent_id, created_at, updated_at FROM folders').all();
    const previousById = new Map(previousFolders.map((folder) => [folder.id, folder]));
    const previousPaths = new Map();
    const pathForPreviousFolder = (id, visiting = new Set()) => {
      if (!id || visiting.has(id)) return '';
      if (previousPaths.has(id)) return previousPaths.get(id);
      const folder = previousById.get(id);
      if (!folder) return '';
      visiting.add(id);
      const parentPath = pathForPreviousFolder(folder.parent_id, visiting);
      const folderPath = parentPath ? `${parentPath}/${folder.name}` : folder.name;
      visiting.delete(id);
      previousPaths.set(id, folderPath);
      return folderPath;
    };
    const previousByPath = new Map(previousFolders.map((folder) => [pathForPreviousFolder(folder.id), folder]));

    db.exec('DELETE FROM notes');
    db.exec('DELETE FROM folders');
    db.exec('DELETE FROM notes_fts');

    const folderIds = new Map();
    const getFolderId = (folderPath) => {
      if (!folderPath) return null;
      let parentId = null;
      let accumulated = '';
      for (const name of folderPath.split('/')) {
        accumulated = accumulated ? `${accumulated}/${name}` : name;
        if (!folderIds.has(accumulated)) {
          const previous = previousByPath.get(accumulated);
          const id = previous?.id ?? randomUUID();
          const timestamp = nowIso();
          db.prepare(
            'INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
          ).run(id, name, parentId, previous?.created_at ?? timestamp, previous?.updated_at ?? timestamp);
          folderIds.set(accumulated, id);
        }
        parentId = folderIds.get(accumulated);
      }
      return parentId;
    };

    const normalized = notes.map((note) => ({
      ...note,
      createdAt: note.createdAt || nowIso(),
      updatedAt: note.updatedAt || nowIso(),
    }));

    for (const folderPath of folderPaths) getFolderId(folderPath);

    for (const note of normalized) {
      db.prepare(
        `INSERT INTO notes (id, title, content, folder_id, file_path, is_pinned, word_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        note.id,
        note.title,
        note.content,
        getFolderId(note.folderPath),
        note.filePath || `${note.title}.md`,
        note.isPinned ? 1 : 0,
        computeWordCount(note.content),
        note.createdAt,
        note.updatedAt,
      );
    }

    for (const note of normalized) syncForNote(note.id, extractTags(note.content));
    for (const note of normalized) rebuildForNote(note.id, note.content);
    pruneOrphanTags();

    return { notes: normalized.length, folders: folderIds.size };
  });
}
