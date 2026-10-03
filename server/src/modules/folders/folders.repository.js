/**
 * 文件夹仓储层：只负责数据存取，不含业务规则。
 */
import { getDb } from '../../db/index.js';

function mapFolder(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findAll() {
  return getDb()
    .prepare('SELECT * FROM folders ORDER BY sort_order ASC, name COLLATE NOCASE ASC')
    .all()
    .map(mapFolder);
}

export function findById(id) {
  return mapFolder(getDb().prepare('SELECT * FROM folders WHERE id = ?').get(id));
}

/** 同级重名检测（parentId 为 null 时比较根级） */
export function findByNameAndParent(name, parentId) {
  return mapFolder(
    getDb()
      .prepare('SELECT * FROM folders WHERE name COLLATE NOCASE = ? AND IFNULL(parent_id, \'\') = IFNULL(?, \'\')')
      .get(name, parentId),
  );
}

export function insert({ id, name, parentId, sortOrder, createdAt, updatedAt }) {
  getDb()
    .prepare(
      'INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, name, parentId, sortOrder, createdAt, updatedAt);
  return findById(id);
}

export function update(id, { name, parentId, sortOrder, updatedAt }) {
  getDb()
    .prepare(
      'UPDATE folders SET name = ?, parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?',
    )
    .run(name, parentId, sortOrder, updatedAt, id);
  return findById(id);
}

export function remove(id) {
  // notes.folder_id 外键为 ON DELETE SET NULL，子目录为 CASCADE：
  // 删除目录不会删掉笔记，笔记会自动落回「未分类」
  return getDb().prepare('DELETE FROM folders WHERE id = ?').run(id).changes;
}

/** 一次取回所有目录的笔记数量，避免 UI 渲染时 N+1 查询 */
export function countNotesGrouped() {
  const rows = getDb()
    .prepare('SELECT folder_id, COUNT(*) AS total FROM notes WHERE folder_id IS NOT NULL GROUP BY folder_id')
    .all();
  return new Map(rows.map((row) => [row.folder_id, row.total]));
}

/** 目录树祖先链，用于移动目录时防止成环 */
export function findAncestorIds(id) {
  const db = getDb();
  const stmt = db.prepare('SELECT parent_id FROM folders WHERE id = ?');
  const ancestors = [];
  let current = id;
  const guard = new Set();

  while (current) {
    const row = stmt.get(current);
    if (!row?.parent_id || guard.has(row.parent_id)) break;
    guard.add(row.parent_id);
    ancestors.push(row.parent_id);
    current = row.parent_id;
  }

  return ancestors;
}
