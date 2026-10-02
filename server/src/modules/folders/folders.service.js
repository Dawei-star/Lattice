import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/index.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { nowIso } from '../../lib/time.js';
import * as repository from './folders.repository.js';
import { config } from '../../config/index.js';
import { VaultAdapter } from '../../vault/vault.adapter.js';
import { sanitizeFilePart } from '../../vault/path.js';
import { resumeWatcher, suspendWatcher } from '../../vault/watcher-control.js';
import * as notesRepository from '../notes/notes.repository.js';

const vault = new VaultAdapter(config.vaultDir);

export function listTree() {
  const folders = repository.findAll();
  const counts = repository.countNotesGrouped();
  const byId = new Map(
    folders.map((folder) => [folder.id, { ...folder, noteCount: counts.get(folder.id) ?? 0, children: [] }]),
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
  if (parentId) getById(parentId);
  if (repository.findByNameAndParent(name, parentId)) {
    throw new ConflictError(`同级下已存在名为「${name}」的目录`);
  }

  const timestamp = nowIso();
  const folder = repository.insert({
    id: randomUUID(),
    name,
    parentId,
    sortOrder,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  vault.ensureDirectorySync(getPath(folder));
  return folder;
}

export function update(id, patch) {
  const current = getById(id);
  const oldPath = getPath(current);
  const name = patch.name ?? current.name;
  const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
  const sortOrder = patch.sortOrder ?? current.sortOrder;

  if (parentId === id) throw new ConflictError('不能把目录移动到它自己下面');
  if (parentId) {
    getById(parentId);
    if (repository.findAncestorIds(parentId).includes(id)) {
      throw new ConflictError('不能把目录移动到它自己的子目录下');
    }
  }

  const duplicate = repository.findByNameAndParent(name, parentId);
  if (duplicate && duplicate.id !== id) {
    throw new ConflictError(`同级下已存在名为「${name}」的目录`);
  }

  const nextFolder = { ...current, name, parentId, sortOrder };
  const newPath = getPath(nextFolder);
  const pathChanges = notesRepository.listByFilePathPrefix(oldPath);

  if (oldPath !== newPath) {
    // 磁盘移动与 DB 事务之间存在中间态（新路径已出现、旧路径已消失、
    // 投影尚未改写），挂起 watcher 防止其以磁盘为准的重建与事务交错
    suspendWatcher();
  }
  try {
    if (oldPath !== newPath) {
      vault.moveDirectorySync(oldPath, newPath);
    }

    const updated = withTransaction(() => {
      const saved = repository.update(id, { name, parentId, sortOrder, updatedAt: nowIso() });
      if (oldPath !== newPath) {
        for (const note of pathChanges) {
          const suffix = note.filePath.slice(oldPath.length);
          notesRepository.updateFilePath(note.id, `${newPath}${suffix}`);
        }
      }
      return saved;
    });
    return updated;
  } catch (error) {
    if (oldPath !== newPath) vault.moveDirectorySync(newPath, oldPath);
    throw error;
  } finally {
    if (oldPath !== newPath) resumeWatcher();
  }
}

export function remove(id) {
  const current = getById(id);
  const oldPath = getPath(current);
  const pathChanges = notesRepository.listByFilePathPrefix(oldPath);
  // 与目录改名同理：搬迁文件期间挂起 watcher，事务提交后再恢复收敛
  suspendWatcher();
  try {
    const moves = vault.relocatePrefixToRootSync(oldPath);
    const moveBySource = new Map(moves.map((move) => [move.fromPath, move.toPath]));

    try {
      withTransaction(() => {
        repository.remove(id);
        for (const note of pathChanges) {
          const nextPath = moveBySource.get(note.filePath);
          if (nextPath) notesRepository.updateFilePath(note.id, nextPath);
        }
      });
    } catch (error) {
      for (const move of [...moves].reverse()) vault.moveSync(move.toPath, move.fromPath);
      throw error;
    }

    vault.removeDirectorySync(oldPath);
    return { deletedFolderCount: 1, affectedNoteCount: pathChanges.length };
  } finally {
    resumeWatcher();
  }
}

function getPath(folder) {
  const parts = [sanitizeFilePart(folder.name, '未命名目录')];
  const visited = new Set([folder.id]);
  let current = folder.parentId ? repository.findById(folder.parentId) : null;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    parts.unshift(sanitizeFilePart(current.name, '未命名目录'));
    current = current.parentId ? repository.findById(current.parentId) : null;
  }
  return parts.join('/');
}
