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
  // 与 getPath 的 sanitizeFilePart 保持一致：磁盘目录名会经过清洗，若入库用
  // 原始名，`a?b` 与 `a_b` 两个目录会映射到同一个磁盘目录，查重也随之失真
  const safeName = sanitizeFilePart(name, '未命名目录');
  if (repository.findByNameAndParent(safeName, parentId)) {
    throw new ConflictError(`同级下已存在名为「${safeName}」的目录`);
  }

  const timestamp = nowIso();
  const folder = repository.insert({
    id: randomUUID(),
    name: safeName,
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
  const name = patch.name === undefined ? current.name : sanitizeFilePart(patch.name, '未命名目录');
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
  // 正向移动是否已落盘：只有真正移过去过，失败时才需要移回来。
  // moveDirectorySync 对不存在的 source 会凭空建出 target，无条件回滚会
  // 制造幽灵空目录，还会用回滚自身的报错掩盖原始 DB 错误。
  let movedOnDisk = false;
  try {
    if (oldPath !== newPath) {
      vault.moveDirectorySync(oldPath, newPath);
      movedOnDisk = true;
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
    if (movedOnDisk) {
      try {
        vault.moveDirectorySync(newPath, oldPath);
      } catch {
        // 回滚失败不掩盖原始错误；下次 reconcile 以磁盘为准收敛投影
      }
    }
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
          if (nextPath) {
            notesRepository.updateFilePath(note.id, nextPath);
          } else {
            // 盘上没有对应文件（搬迁前就缺失）：清掉悬空路径，否则目录删除后
            // 这行会一直指向已消失的文件，只能等全量 reconcile 兜底
            notesRepository.updateFilePath(note.id, null);
          }
        }
      });
    } catch (error) {
      for (const move of [...moves].reverse()) {
        try {
          vault.moveSync(move.toPath, move.fromPath);
        } catch {
          // 单个回滚失败不中断其余回滚；最终以 resumeWatcher 的收敛对齐兜底
        }
      }
      throw error;
    }

    // 此时文件已全部搬出、事务也已提交：目录里最多剩空子目录。删除失败
    // （空目录被杀软/网盘占用）若继续抛错，客户端会收到 500 但重试却报
    // 「目录不存在」——降级为非致命，残留空目录交给 resumeWatcher 的收敛兜底
    try {
      vault.removeDirectorySync(oldPath);
    } catch {
      // 以磁盘为准的下一次 reconcile 会清掉这行投影
    }
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
