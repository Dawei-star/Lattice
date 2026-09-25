/**
 * 文件夹服务层：业务规则与编排。
 * 不依赖 req/res，可以被测试与后台任务直接调用。
 */
import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { nowIso } from '../../lib/time.js';
import * as repository from './folders.repository.js';

/**
 * 返回嵌套目录树，每个节点带上直接归属的笔记数量。
 */
export function listTree() {
  const folders = repository.findAll();
  const counts = repository.countNotesGrouped();
  const byId = new Map(
    folders.map((folder) => [
      folder.id,
      { ...folder, noteCount: counts.get(folder.id) ?? 0, children: [] },
    ]),
  );

  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

export function getById(id) {
  const folder = repository.findById(id);
  if (!folder) throw new NotFoundError('目录不存在');
  return folder;
}

export function create({ name, parentId = null, sortOrder = 0 }) {
  if (parentId) getById(parentId); // 父目录必须存在

  if (repository.findByNameAndParent(name, parentId)) {
    throw new ConflictError(`同级下已存在名为「${name}」的目录`);
  }

  const timestamp = nowIso();
  return repository.insert({
    id: randomUUID(),
    name,
    parentId,
    sortOrder,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function update(id, patch) {
  const current = getById(id);

  const name = patch.name ?? current.name;
  const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
  const sortOrder = patch.sortOrder ?? current.sortOrder;

  if (parentId === id) throw new ConflictError('不能把目录移动到它自己下面');

  if (parentId) {
    getById(parentId);
    // 防止把父目录挂到自己的后代下，形成环
    if (repository.findAncestorIds(parentId).includes(id)) {
      throw new ConflictError('不能把目录移动到它自己的子目录下');
    }
  }

  const duplicate = repository.findByNameAndParent(name, parentId);
  if (duplicate && duplicate.id !== id) {
    throw new ConflictError(`同级下已存在名为「${name}」的目录`);
  }

  return repository.update(id, { name, parentId, sortOrder, updatedAt: nowIso() });
}

/**
 * 删除目录。子目录级联删除，其中笔记不被删除，而是回到「未分类」。
 * @returns {{ deletedFolderCount: number, affectedNoteCount: number }}
 */
export function remove(id) {
  getById(id);
  const affectedNoteCount = repository.countNotes(id);
  repository.remove(id);
  return { deletedFolderCount: 1, affectedNoteCount };
}
