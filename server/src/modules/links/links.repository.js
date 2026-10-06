/** 双向链接仓储层 */
import { getDb } from '../../db/index.js';

export function deleteBySource(sourceNoteId) {
  getDb().prepare('DELETE FROM links WHERE source_note_id = ?').run(sourceNoteId);
}

export function insert({ sourceNoteId, targetTitle, targetNoteId, createdAt }) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO links (source_note_id, target_title, target_note_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(sourceNoteId, targetTitle, targetNoteId, createdAt);
}

/**
 * 出链：本笔记指向别处的链接，带上已解析目标笔记的标题。
 */
export function listOutgoing(sourceNoteId) {
  return getDb()
    .prepare(
      `SELECT l.target_title AS targetTitle,
              l.target_note_id AS targetNoteId,
              n.title AS resolvedTitle
         FROM links l
         LEFT JOIN notes n ON n.id = l.target_note_id
        WHERE l.source_note_id = ?
        ORDER BY l.target_title COLLATE NOCASE ASC`,
    )
    .all(sourceNoteId)
    .map((row) => ({
      targetTitle: row.targetTitle,
      targetNoteId: row.targetNoteId,
      resolvedTitle: row.resolvedTitle,
      resolved: row.targetNoteId !== null,
    }));
}

/**
 * 反链：哪些笔记链接到了本笔记。
 */
export function listBacklinks(targetNoteId) {
  return getDb()
    .prepare(
      `SELECT l.source_note_id AS sourceNoteId, n.title AS sourceTitle, n.updated_at AS sourceUpdatedAt
         FROM links l
         JOIN notes n ON n.id = l.source_note_id
        WHERE l.target_note_id = ?
        ORDER BY n.updated_at DESC`,
    )
    .all(targetNoteId)
    .map((row) => ({
      sourceNoteId: row.sourceNoteId,
      sourceTitle: row.sourceTitle,
      sourceUpdatedAt: row.sourceUpdatedAt,
    }));
}

/**
 * 一条笔记改名/新建后，把此前指向该标题的悬空链接「认领」过来。
 * 同名笔记多于一个时，链接统一指向最近更新的那一篇。
 */
export function claimDanglingLinks(title, noteId) {
  return getDb()
    .prepare(
      `UPDATE links SET target_note_id = ?
        WHERE target_note_id IS NULL
          AND target_title COLLATE NOCASE = ?`,
    )
    .run(noteId, title).changes;
}

/** 指向某篇笔记的全部链接（含目标标题），供外部改名后重新解析归属。 */
export function listLinksPointingAt(noteId) {
  return getDb()
    .prepare(
      `SELECT source_note_id AS sourceNoteId, target_title AS targetTitle
         FROM links
        WHERE target_note_id = ?`,
    )
    .all(noteId);
}

export function updateLinkTarget({ sourceNoteId, targetTitle, targetNoteId }) {
  return getDb()
    .prepare('UPDATE links SET target_note_id = ? WHERE source_note_id = ? AND target_title = ?')
    .run(targetNoteId, sourceNoteId, targetTitle).changes;
}

/** 图谱用的边集合（仅含已解析的链接） */
export function listEdges() {
  return getDb()
    .prepare(
      `SELECT l.source_note_id AS source, l.target_note_id AS target
         FROM links l
        WHERE l.target_note_id IS NOT NULL AND l.target_note_id <> l.source_note_id
        GROUP BY l.source_note_id, l.target_note_id`,
    )
    .all();
}

/** 悬空链接清单：被引用但尚不存在的笔记标题 */
export function listDangling() {
  return getDb()
    .prepare(
      `SELECT l.target_title AS targetTitle, COUNT(DISTINCT l.source_note_id) AS referenceCount
         FROM links l
        WHERE l.target_note_id IS NULL
        GROUP BY l.target_title COLLATE NOCASE
        ORDER BY referenceCount DESC, l.target_title COLLATE NOCASE ASC`,
    )
    .all()
    .map((row) => ({ targetTitle: row.targetTitle, referenceCount: row.referenceCount }));
}

/** Review 用的悬空链接证据：除目标标题外保留引用来源，便于用户逐条回看。 */
export function listDanglingDetails() {
  return getDb()
    .prepare(
      `SELECT l.target_title AS targetTitle,
              l.source_note_id AS sourceId,
              n.title AS sourceTitle,
              n.file_path AS sourcePath
         FROM links l
         JOIN notes n ON n.id = l.source_note_id
        WHERE l.target_note_id IS NULL
        ORDER BY l.target_title COLLATE NOCASE ASC, n.updated_at DESC`,
    )
    .all()
    .map((row) => ({
      targetTitle: row.targetTitle,
      sourceId: row.sourceId,
      sourceTitle: row.sourceTitle,
      sourcePath: row.sourcePath || `${row.sourceTitle}.md`,
    }));
}

/** 批量统计指定笔记的出链/入链数量，避免逐条查询 */
export function countsForNotes(noteIds) {
  const empty = { outgoing: new Map(), incoming: new Map() };
  if (noteIds.length === 0) return empty;

  const placeholders = noteIds.map(() => '?').join(',');
  const db = getDb();

  const outgoing = db
    .prepare(
      `SELECT source_note_id AS id, COUNT(*) AS total FROM links
        WHERE source_note_id IN (${placeholders}) GROUP BY source_note_id`,
    )
    .all(...noteIds);
  const incoming = db
    .prepare(
      `SELECT target_note_id AS id, COUNT(*) AS total FROM links
        WHERE target_note_id IS NOT NULL AND target_note_id IN (${placeholders})
        GROUP BY target_note_id`,
    )
    .all(...noteIds);

  return {
    outgoing: new Map(outgoing.map((row) => [row.id, row.total])),
    incoming: new Map(incoming.map((row) => [row.id, row.total])),
  };
}
