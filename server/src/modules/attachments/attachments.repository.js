/** 附件仓储层：只负责 attachments 表的读写 */
import { getDb } from '../../db/index.js';

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    storedName: row.stored_name,
    origName: row.orig_name,
    mime: row.mime,
    size: row.size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findById(id) {
  return mapRow(getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id));
}

export function insert({ id, storedName, origName, mime, size, createdAt, updatedAt }) {
  getDb()
    .prepare(
      `INSERT INTO attachments (id, stored_name, orig_name, mime, size, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, storedName, origName, mime, size, createdAt, updatedAt);
  return findById(id);
}

export function listAll() {
  return getDb()
    .prepare('SELECT * FROM attachments ORDER BY created_at DESC')
    .all()
    .map(mapRow);
}

export function remove(id) {
  return getDb().prepare('DELETE FROM attachments WHERE id = ?').run(id).changes;
}
