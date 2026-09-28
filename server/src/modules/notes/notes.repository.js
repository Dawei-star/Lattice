/** 笔记仓储层 */
import { getDb } from '../../db/index.js';
import { toPlainText } from '../../lib/markdown.js';

export const SORT_SQL = {
  updated: 'n.is_pinned DESC, n.updated_at DESC',
  created: 'n.is_pinned DESC, n.created_at DESC',
  title: 'n.is_pinned DESC, n.title COLLATE NOCASE ASC',
};

function mapNote(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    folderId: row.folder_id,
    isPinned: row.is_pinned === 1,
    wordCount: row.word_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSummary(row) {
  return {
    id: row.id,
    title: row.title,
    folderId: row.folder_id,
    isPinned: row.is_pinned === 1,
    wordCount: row.word_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    excerpt: buildExcerpt(row.content),
  };
}

/** 列表只给摘要，避免把整篇正文塞进响应体 */
function buildExcerpt(content, maxLength = 140) {
  const plain = toPlainText(content);
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain;
}

export function findById(id) {
  return mapNote(getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id));
}

export function findByTitle(title) {
  return getDb()
    .prepare('SELECT * FROM notes WHERE title COLLATE NOCASE = ? ORDER BY updated_at DESC')
    .all(title)
    .map(mapNote);
}

export function insert({ id, title, content, folderId, wordCount, createdAt, updatedAt }) {
  getDb()
    .prepare(
      `INSERT INTO notes (id, title, content, folder_id, is_pinned, word_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(id, title, content, folderId, wordCount, createdAt, updatedAt);
  return findById(id);
}

export function update(id, { title, content, folderId, isPinned, wordCount, updatedAt }) {
  getDb()
    .prepare(
      `UPDATE notes
          SET title = ?, content = ?, folder_id = ?, is_pinned = ?, word_count = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(title, content, folderId, isPinned ? 1 : 0, wordCount, updatedAt, id);
  return findById(id);
}

export function remove(id) {
  return getDb().prepare('DELETE FROM notes WHERE id = ?').run(id).changes;
}

/**
 * 带过滤条件的列表查询。
 * @param {{ folderId?: string | null, tagId?: string | null, sort?: keyof SORT_SQL, limit: number, offset: number }} options
 */
export function list({ folderId, tagId, sort = 'updated', limit, offset }) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (folderId === '__none__') {
    conditions.push('n.folder_id IS NULL');
  } else if (folderId) {
    conditions.push('n.folder_id = ?');
    params.push(folderId);
  }

  if (tagId) {
    conditions.push('EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag_id = ?)');
    params.push(tagId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = SORT_SQL[sort] ?? SORT_SQL.updated;

  const total = db.prepare(`SELECT COUNT(*) AS total FROM notes n ${where}`).get(...params).total;

  const rows = db
    .prepare(`SELECT * FROM notes n ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map(mapSummary);

  return { items: rows, total };
}

/** 图谱与统计用的轻量全量投影 */
export function listBrief() {
  return getDb()
    .prepare('SELECT id, title, folder_id, is_pinned, word_count, updated_at FROM notes')
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      folderId: row.folder_id,
      filePath: `${safeFilePart(row.title)}.md`,
      isPinned: row.is_pinned === 1,
      wordCount: row.word_count,
      updatedAt: row.updated_at,
    }));
}

/** 全量轻量索引：供快速切换器、双链解析与嵌入预览使用，不含正文 */
export function listIndex() {
  return getDb()
    .prepare('SELECT id, title, folder_id, is_pinned, word_count, updated_at FROM notes ORDER BY updated_at DESC')
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      folderId: row.folder_id,
      filePath: `${safeFilePart(row.title)}.md`,
      isPinned: row.is_pinned === 1,
      wordCount: row.word_count,
      updatedAt: row.updated_at,
    }));
}

function safeFilePart(value) {
  return String(value || '未命名笔记')
    .replace(/[<>:"/\\|?*\u0000]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || '未命名笔记';
}

export function statistics() {
  const db = getDb();
  return {
    noteCount: db.prepare('SELECT COUNT(*) AS total FROM notes').get().total,
    folderCount: db.prepare('SELECT COUNT(*) AS total FROM folders').get().total,
    tagCount: db.prepare('SELECT COUNT(*) AS total FROM tags').get().total,
    linkCount: db.prepare('SELECT COUNT(*) AS total FROM links WHERE target_note_id IS NOT NULL').get().total,
    danglingCount: db.prepare('SELECT COUNT(*) AS total FROM links WHERE target_note_id IS NULL').get().total,
    totalWords: db.prepare('SELECT COALESCE(SUM(word_count), 0) AS total FROM notes').get().total,
  };
}
