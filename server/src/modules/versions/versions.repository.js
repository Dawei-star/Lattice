/** 笔记版本仓储层：只管 note_versions 的存取，不含节流/保留策略（那在 service）。 */
import { getDb } from '../../db/index.js';

function mapVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    noteId: row.note_id,
    title: row.title,
    content: row.content,
    wordCount: row.word_count,
    createdAt: row.created_at,
  };
}

export function insert({ id, noteId, title, content, wordCount, createdAt }) {
  getDb()
    .prepare(
      `INSERT INTO note_versions (id, note_id, title, content, word_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, noteId, title, content, wordCount, createdAt);
  return findById(id);
}

export function findById(id) {
  return mapVersion(getDb().prepare('SELECT * FROM note_versions WHERE id = ?').get(id));
}

/** 某篇笔记最近一条快照（用于节流判定），无则 null */
export function latestByNote(noteId) {
  return mapVersion(
    getDb()
      .prepare('SELECT * FROM note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(noteId),
  );
}

/** 历史列表（不含正文，避免整篇塞进响应） */
export function listByNote(noteId) {
  return getDb()
    .prepare(
      `SELECT id, note_id, title, word_count, created_at, LENGTH(content) AS size
         FROM note_versions WHERE note_id = ? ORDER BY created_at DESC`,
    )
    .all(noteId)
    .map((row) => ({
      id: row.id,
      noteId: row.note_id,
      title: row.title,
      wordCount: row.word_count,
      size: row.size,
      createdAt: row.created_at,
    }));
}

export function countByNote(noteId) {
  return getDb().prepare('SELECT COUNT(*) AS total FROM note_versions WHERE note_id = ?').get(noteId).total;
}

/** 只保留最近 keep 条，其余按时间淘汰；返回删除条数 */
export function trimToLatest(noteId, keep) {
  const result = getDb()
    .prepare(
      `DELETE FROM note_versions
        WHERE note_id = ?
          AND id NOT IN (
            SELECT id FROM note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT ?
          )`,
    )
    .run(noteId, noteId, keep);
  return result.changes;
}

export function removeById(id) {
  return getDb().prepare('DELETE FROM note_versions WHERE id = ?').run(id).changes;
}
