/**
 * Vault 增量同步引擎。
 *
 * 真源是磁盘上的 Markdown 文件，SQLite 只是可重建的投影。此前任意一次文件变更
 * 都会触发「全库重扫 + 整库 DELETE/INSERT 重建」，几千篇笔记时每次自动保存都是
 * 秒级同步阻塞。现在分两条路径：
 *
 * - applyVaultChange：watcher 报告了具体文件 → 只对该文件做 upsert / 删除；
 * - reconcileVault：启动或目录结构变化 → 以路径集合做差量对齐。
 *
 * 两条路径都以 content_hash（文件字节的 sha256）判定「未变化」并跳过一切写库，
 * 因此事件重复触发是廉价的；标签 / 链接的派生重建只发生在真正变化的笔记上。
 * 目录 ID 以路径为自然键复用（ux_folders_parent_name 唯一索引），
 * 标签不再整体删除而是事后清理孤儿——前端的 folderId / tagId 因此跨重建稳定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb, withTransaction } from '../db/index.js';
import { computeWordCount, extractTags } from '../lib/markdown.js';
import { nowIso } from '../lib/time.js';
import { claimForTitle, rebuildForNote } from '../modules/links/links.service.js';
import { listLinksPointingAt, updateLinkTarget } from '../modules/links/links.repository.js';
import { findByFilePath, findByTitle } from '../modules/notes/notes.repository.js';
import * as historyStore from '../modules/notes/notes.history.js';
import { scheduleNoteIndex } from '../modules/ai/ai.indexer.js';
import { pruneOrphans as pruneOrphanTags, syncForNote } from '../modules/tags/tags.service.js';
import { hashRaw, parseMarkdownDocument, serializeMarkdownDocument } from './markdown.js';
import { normalizeVaultRelativePath, resolveVaultPath } from './path.js';

/**
 * 单文件事件入口：文件被保存 / 新建 / 删除时由 watcher 调度。
 * @returns {Promise<{file: string, action: 'added'|'updated'|'removed'|'skipped'|'absent'}>}
 */
export async function applyVaultChange(adapter, relativePath) {
  const safePath = normalizeVaultRelativePath(relativePath);
  const db = getDb();

  let raw = null;
  try {
    raw = await fs.promises.readFile(resolveVaultPath(adapter.rootDir, safePath), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (raw === null) {
    const row = db.prepare('SELECT id FROM notes WHERE file_path = ?').get(safePath);
    if (!row) return { file: safePath, action: 'absent' };
    return withTransaction(() => {
      db.prepare('DELETE FROM notes WHERE file_path = ?').run(safePath);
      pruneOrphanTags();
      pruneEmptyFolderChain(adapter, parentPathOf(safePath));
      return { file: safePath, id: row.id, action: 'removed' };
    });
  }

  let contentHash = hashRaw(raw);
  const known = db.prepare('SELECT content_hash FROM notes WHERE file_path = ?').get(safePath);
  if (known && known.content_hash === contentHash) {
    return { file: safePath, action: 'skipped' };
  }

  let note = parseMarkdownDocument(raw, safePath);
  // 与 scan() 语义一致：没有 frontmatter 的文件补写一份（分配稳定 id），否则
  // 每次读取都会得到不同的随机 id，投影无法与上一轮对齐。
  if (!note.hasFrontmatter) {
    note = { ...note, id: randomUUID() };
    ({ raw, contentHash, note } = await rewriteWithFrontmatter(adapter, note, raw));
  }

  // 同一 id 出现在另一个仍存在的文件上（复制文件带出了 legacy id）：
  // 让当前文件换新 id，保持「一个 id 只属于一个文件」。
  const clash = db.prepare('SELECT file_path FROM notes WHERE id = ?').get(note.id);
  if (clash && clash.file_path && clash.file_path !== safePath && adapter.existsSync(clash.file_path)) {
    note = { ...note, id: randomUUID() };
    ({ raw, contentHash, note } = await rewriteWithFrontmatter(adapter, note, raw));
  }

  const previous = known ? findByFilePath(safePath) : null;
  if (previous && (previous.title !== note.title || previous.content !== note.content)) {
    historyStore.createSnapshot(previous, serializeMarkdownDocument(previous));
  }

  withTransaction(() => {
    // 该路径上的其他占用者：它的文件已被当前文件替换，DB 行随之清位。
    // （改名场景下行早已迁移到新路径，这里通常查不到东西。）
    const squatter = db.prepare('SELECT id FROM notes WHERE file_path = ? AND id <> ?').get(safePath, note.id);
    if (squatter) db.prepare('DELETE FROM notes WHERE id = ?').run(squatter.id);
    upsertProjection(note, contentHash);
    pruneOrphanTags();
  });

  // 语义索引跟进（内部自带保护，失败不影响投影）
  scheduleNoteIndex(note.id, { contentHash });

  return { file: safePath, action: known ? 'updated' : 'added' };
}

/**
 * 投影对齐：让 DB 与磁盘的路径集合、目录结构和（full 模式下的）文件内容一致。
 *
 * - `full`：启动时用。逐文件读盘比对哈希，把「停机期间的外部改动」补进投影；
 *   未变化的文件零写入。首轮会为存量行回填 content_hash，之后启动近乎只读。
 * - `membership`：watcher 收到目录级 / 未知事件时用。只对齐路径集合与目录，
 *   已知文件不读内容——内容变化一定会以 .md 事件单独送达，无需在这里猜。
 */
export async function reconcileVault(adapter, { mode = 'full' } = {}) {
  await adapter.ensure();
  const diskPaths = adapter.listMarkdownPaths();
  const diskFolders = await adapter.scanFolders();
  const db = getDb();

  const diskSet = new Set(diskPaths);
  const rows = db.prepare('SELECT id, file_path, content_hash FROM notes').all();
  const rowByPath = new Map(rows.filter((row) => row.file_path).map((row) => [row.file_path, row]));
  // 本轮运行结束后将存在的全部笔记 id：phase A 的 id 冲突判定必须包含
  // 同批尚未入库的文件，否则两个同 id 新文件会被写进同一行。
  const seenIds = new Set(rows.map((row) => row.id));

  const stats = { added: 0, updated: 0, removed: 0, skipped: 0, notes: rows.length, folders: diskFolders.length };

  // 阶段 A（事务外，可自由 await）：决定每个待处理文件的最终字节与解析结果。
  const pending = [];
  for (const relativePath of diskPaths) {
    const row = rowByPath.get(relativePath);
    if (mode === 'membership' && row) continue; // 内容变化由该文件自己的 .md 事件负责

    const raw = fs.readFileSync(resolveVaultPath(adapter.rootDir, relativePath), 'utf8');
    const contentHash = hashRaw(raw);
    if (row && row.content_hash === contentHash) {
      stats.skipped += 1;
      continue;
    }

    let note = parseMarkdownDocument(raw, relativePath);
    let nextRaw = raw;
    let nextHash = contentHash;
    if (!note.hasFrontmatter) {
      note = { ...note, id: randomUUID() };
      nextRaw = serializeMarkdownDocument({ ...note, filePath: relativePath });
      nextHash = hashRaw(nextRaw);
    }
    const ownsId = row?.id === note.id;
    const clash = ownsId ? null : db.prepare('SELECT file_path FROM notes WHERE id = ?').get(note.id);
    const clashOnDisk = clash && clash.file_path && clash.file_path !== relativePath && adapter.existsSync(clash.file_path);
    if (clashOnDisk || (!ownsId && seenIds.has(note.id))) {
      note = { ...note, id: randomUUID() };
      nextRaw = serializeMarkdownDocument({ ...note, filePath: relativePath });
      nextHash = hashRaw(nextRaw);
    }
    seenIds.add(note.id);
    if (nextRaw !== raw) await writeRawAtomic(adapter, relativePath, nextRaw);
    pending.push({ note, contentHash: nextHash, existed: Boolean(row) });
  }

  // 阶段 B（单事务）：目录 upsert → 笔记 upsert → 清理消失的路径与孤儿。
  withTransaction(() => {
    // 盘上的目录（含空目录）全部进入投影：目录以磁盘为准，与 scanFolders 语义一致
    for (const folderPath of diskFolders) ensureFolderPath(folderPath);

    for (const { note, contentHash, existed } of pending) {
      const squatter = db.prepare('SELECT id FROM notes WHERE file_path = ? AND id <> ?').get(note.filePath, note.id);
      if (squatter) db.prepare('DELETE FROM notes WHERE id = ?').run(squatter.id);
      upsertProjection(note, contentHash);
      if (existed) stats.updated += 1;
      else stats.added += 1;
      stats.notes += 1;
    }

    // 消失的文件（以及从未有过路径的遗留行）：以「盘上路径集合」为准。
    // 改名迁移走的行 file_path 已更新为新路径，不会误删。
    const removed = db
      .prepare('SELECT id, file_path FROM notes')
      .all()
      .filter((row) => !row.file_path || !diskSet.has(row.file_path));
    for (const row of removed) {
      db.prepare('DELETE FROM notes WHERE id = ?').run(row.id);
      stats.removed += 1;
      stats.notes -= 1;
    }

    pruneMissingFolders(diskFolders);
    pruneOrphanTags();
  });

  // 语义索引跟进（内部自带保护，失败不影响投影）；被删除的笔记由外键级联清理
  for (const { note, contentHash } of pending) {
    scheduleNoteIndex(note.id, { contentHash });
  }

  return stats;
}

/** 必须在事务内调用：写入单篇笔记的投影并重建其派生数据。 */
function upsertProjection(note, contentHash) {
  const db = getDb();
  const folderId = ensureFolderPath(note.folderPath);
  const timestamp = nowIso();
  const existing = db.prepare('SELECT id, title FROM notes WHERE id = ?').get(note.id);
  const wordCount = computeWordCount(note.content);

  if (existing) {
    db.prepare(
      `UPDATE notes
          SET title = ?, content = ?, folder_id = ?, file_path = ?, is_pinned = ?,
              word_count = ?, content_hash = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      note.title,
      note.content,
      folderId,
      note.filePath,
      note.isPinned ? 1 : 0,
      wordCount,
      contentHash,
      note.updatedAt ?? timestamp,
      note.id,
    );
    if (existing.title !== note.title) {
      releaseStaleLinks(note.id, note.title);
      claimForTitle(note.title, note.id);
    }
  } else {
    db.prepare(
      `INSERT INTO notes (id, title, content, folder_id, file_path, is_pinned, word_count, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      note.id,
      note.title,
      note.content,
      folderId,
      note.filePath,
      note.isPinned ? 1 : 0,
      wordCount,
      contentHash,
      note.createdAt ?? timestamp,
      note.updatedAt ?? timestamp,
    );
    claimForTitle(note.title, note.id);
  }

  syncForNote(note.id, extractTags(note.content));
  rebuildForNote(note.id, note.content);
}

/**
 * 笔记被外部改名后，原本指向它的链接（target_note_id = 该笔记）的文本仍是旧标题，
 * 不能继续霸占指向关系：按链接文本重新解析归属，解析不到就退回悬空。
 */
function releaseStaleLinks(noteId, newTitle) {
  const normalizedNewTitle = newTitle.toLowerCase();
  for (const link of listLinksPointingAt(noteId)) {
    if (link.targetTitle.toLowerCase() === normalizedNewTitle) continue;
    const owner = findByTitle(link.targetTitle)[0];
    updateLinkTarget({ sourceNoteId: link.sourceNoteId, targetTitle: link.targetTitle, targetNoteId: owner?.id ?? null });
  }
}

/** 目录链逐级 upsert（读改写都走 parent+name 唯一索引），返回最深层目录 id。 */
function ensureFolderPath(folderPath) {
  if (!folderPath) return null;
  const db = getDb();
  let parentId = null;
  let accumulated = '';
  for (const name of folderPath.split('/')) {
    accumulated = accumulated ? `${accumulated}/${name}` : name;
    const existing = db
      .prepare("SELECT id FROM folders WHERE IFNULL(parent_id, '') = ? AND name = ?")
      .get(parentId ?? '', name);
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const id = randomUUID();
    const timestamp = nowIso();
    db.prepare(
      'INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run(id, name, parentId, timestamp, timestamp);
    parentId = id;
  }
  return parentId;
}

/** 只读版的 ensureFolderPath：按路径查现有目录 id。 */
function lookupFolderPath(folderPath) {
  if (!folderPath) return null;
  const db = getDb();
  let parentId = null;
  let accumulated = '';
  for (const name of folderPath.split('/')) {
    accumulated = accumulated ? `${accumulated}/${name}` : name;
    const existing = db
      .prepare("SELECT id FROM folders WHERE IFNULL(parent_id, '') = ? AND name = ?")
      .get(parentId ?? '', name);
    if (!existing) return null;
    parentId = existing.id;
  }
  return parentId;
}

/**
 * 磁盘上已消失的空目录对应的行要清掉，否则外部删目录后 DB 里留下幽灵目录。
 * 只删「无笔记、无子目录、且盘上不存在」的行，从最深层往上逐层判断。
 */
function pruneMissingFolders(diskFolders) {
  const db = getDb();
  const diskFolderSet = new Set(diskFolders);
  const folders = db.prepare('SELECT id, name, parent_id FROM folders').all();
  const pathById = new Map();
  const pathFor = (id, visiting = new Set()) => {
    if (pathById.has(id)) return pathById.get(id);
    if (!id || visiting.has(id)) return '';
    visiting.add(id);
    const folder = folders.find((row) => row.id === id);
    const parentPath = folder ? pathFor(folder.parent_id, visiting) : '';
    const result = folder ? (parentPath ? `${parentPath}/${folder.name}` : folder.name) : '';
    visiting.delete(id);
    pathById.set(id, result);
    return result;
  };

  // 深层在前：先删子目录，父目录的子计数随之减少
  const ordered = folders
    .map((row) => ({ ...row, path: pathFor(row.id) }))
    .filter((row) => row.path)
    .sort((a, b) => b.path.split('/').length - a.path.split('/').length);

  for (const row of ordered) {
    if (diskFolderSet.has(row.path)) continue;
    const noteCount = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE folder_id = ?').get(row.id).c;
    const childCount = db.prepare('SELECT COUNT(*) AS c FROM folders WHERE parent_id = ?').get(row.id).c;
    if (noteCount > 0 || childCount > 0) continue;
    db.prepare('DELETE FROM folders WHERE id = ?').run(row.id);
  }
}

/** 笔记删除后，把它所在的目录链上「盘上已不存在且彻底为空」的目录清掉。 */
function pruneEmptyFolderChain(adapter, folderPath) {
  if (!folderPath) return;
  const db = getDb();
  const segments = folderPath.split('/');
  for (let end = segments.length; end >= 1; end -= 1) {
    const candidate = segments.slice(0, end).join('/');
    const id = lookupFolderPath(candidate);
    if (!id) return;
    const noteCount = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE folder_id = ?').get(id).c;
    const childCount = db.prepare('SELECT COUNT(*) AS c FROM folders WHERE parent_id = ?').get(id).c;
    if (noteCount > 0 || childCount > 0) return;
    if (adapter.directoryExists(candidate)) return; // 盘上还在的空目录是用户数据，保留
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  }
}

async function rewriteWithFrontmatter(adapter, note, _previousRaw) {
  const raw = serializeMarkdownDocument({ ...note, filePath: note.filePath });
  await writeRawAtomic(adapter, note.filePath, raw);
  return { raw, contentHash: hashRaw(raw), note };
}

async function writeRawAtomic(adapter, relativePath, raw) {
  const target = resolveVaultPath(adapter.rootDir, relativePath);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, raw, 'utf8');
  await fs.promises.rename(temporary, target);
}

function parentPathOf(relativePath) {
  const parts = relativePath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : null;
}
