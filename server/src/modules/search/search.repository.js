/** 搜索仓储层 */
import { getDb } from '../../db/index.js';

function mapRow(row, excerpt) {
  return {
    id: row.id,
    title: row.title,
    folderId: row.folder_id,
    isPinned: row.is_pinned === 1,
    updatedAt: row.updated_at,
    excerpt,
  };
}

/**
 * FTS5 全文检索。
 * trigram 分词器要求检索词至少 3 个字符，短于此长度的查询由 service 层走 LIKE 分支。
 * @param {string} phrase 已转义并加引号的短语
 * @param {number} limit
 */
export function searchFullText(phrase, limit) {
  return getDb()
    .prepare(
      `SELECT n.id, n.title, n.folder_id, n.is_pinned, n.updated_at, n.content
         FROM notes_fts
         JOIN notes n ON n.id = notes_fts.note_id
        WHERE notes_fts MATCH ?
        ORDER BY bm25(notes_fts) ASC, n.updated_at DESC
        LIMIT ?`,
    )
    .all(phrase, limit);
}

/**
 * LIKE 兜底检索：用于短查询，以及 FTS 未命中时的二次尝试。
 * @param {string} pattern 已转义的通配模式
 * @param {number} limit
 */
export function searchLike(pattern, limit) {
  return getDb()
    .prepare(
      `SELECT id, title, folder_id, is_pinned, updated_at, content
         FROM notes
        WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
        ORDER BY is_pinned DESC, updated_at DESC
        LIMIT ?`,
    )
    .all(pattern, pattern, limit);
}

export { mapRow };
