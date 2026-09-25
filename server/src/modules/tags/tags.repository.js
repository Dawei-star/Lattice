/** 标签仓储层 */
import { getDb } from '../../db/index.js';

function mapTag(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    noteCount: row.note_count ?? 0,
  };
}

export function findAllWithCounts() {
  return getDb()
    .prepare(
      `SELECT t.id, t.name, t.created_at, COUNT(nt.note_id) AS note_count
         FROM tags t
         LEFT JOIN note_tags nt ON nt.tag_id = t.id
        GROUP BY t.id, t.name, t.created_at
        ORDER BY note_count DESC, t.name COLLATE NOCASE ASC`,
    )
    .all()
    .map(mapTag);
}

export function findById(id) {
  return mapTag(getDb().prepare('SELECT * FROM tags WHERE id = ?').get(id));
}

export function findByName(name) {
  return mapTag(getDb().prepare('SELECT * FROM tags WHERE name COLLATE NOCASE = ?').get(name));
}

export function insert({ id, name, createdAt }) {
  getDb().prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(id, name, createdAt);
  return findByName(name);
}

export function remove(id) {
  // note_tags 外键为 CASCADE，会自动解除与笔记的关联
  return getDb().prepare('DELETE FROM tags WHERE id = ?').run(id).changes;
}

export function clearNoteTags(noteId) {
  getDb().prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
}

export function attachToNote(noteId, tagId) {
  getDb()
    .prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)')
    .run(noteId, tagId);
}

export function findTagsForNotes(noteIds) {
  if (noteIds.length === 0) return new Map();

  const placeholders = noteIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT nt.note_id, t.id, t.name
         FROM note_tags nt
         JOIN tags t ON t.id = nt.tag_id
        WHERE nt.note_id IN (${placeholders})
        ORDER BY t.name COLLATE NOCASE ASC`,
    )
    .all(...noteIds);

  /** @type {Map<string, Array<{ id: string, name: string }>>} */
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.note_id)) grouped.set(row.note_id, []);
    grouped.get(row.note_id).push({ id: row.id, name: row.name });
  }
  return grouped;
}

export function findIdsByNames(names) {
  if (names.length === 0) return new Map();
  const placeholders = names.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT id, name FROM tags WHERE name COLLATE NOCASE IN (${placeholders})`)
    .all(...names);
  return new Map(rows.map((row) => [row.name.toLowerCase(), row.id]));
}
