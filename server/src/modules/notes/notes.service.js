import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { computeWordCount, extractNoteTags, inferTitle } from '../../lib/markdown.js';
import { nowIso } from '../../lib/time.js';
import * as foldersRepository from '../folders/folders.repository.js';
import * as linksRepository from '../links/links.repository.js';
import * as linksService from '../links/links.service.js';
import * as tagsRepository from '../tags/tags.repository.js';
import * as tagsService from '../tags/tags.service.js';
import * as repository from './notes.repository.js';
import { removeNoteIndexes } from '../ai/ai.embeddings.js';
import { config } from '../../config/index.js';
import { VaultAdapter } from '../../vault/vault.adapter.js';
import { hashDocument, parseMarkdownDocument } from '../../vault/markdown.js';
import { sanitizeFilePart } from '../../vault/path.js';
import * as historyStore from './notes.history.js';

const MAX_TITLE_LENGTH = 200;
const vault = new VaultAdapter(config.vaultDir);

function normalizeTitle(rawTitle, fallbackContent) {
  const title = ((rawTitle ?? '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim() || inferTitle(fallbackContent))
    .replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
    .trim();
  return title.slice(0, MAX_TITLE_LENGTH);
}

function assertFolderExists(folderId) {
  if (folderId && !foldersRepository.findById(folderId)) {
    throw new ValidationError('指定的目录不存在', [
      { in: 'body', field: 'folderId', message: '目录不存在' },
    ]);
  }
}

function folderPath(folderId) {
  const parts = [];
  const visited = new Set();
  let current = folderId ? foldersRepository.findById(folderId) : null;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    parts.unshift(sanitizeFilePart(current.name));
    current = current.parentId ? foldersRepository.findById(current.parentId) : null;
  }
  return parts.join('/');
}

function derivedNoteFilePath(note) {
  const directory = folderPath(note.folderId);
  return `${directory ? `${directory}/` : ''}${sanitizeFilePart(note.title)}.md`;
}

function noteFilePath(note) {
  return note.filePath || derivedNoteFilePath(note);
}

function allocateFilePath(note, { excludeId = null } = {}) {
  const base = derivedNoteFilePath(note);
  const extension = '.md';
  const stem = base.slice(0, -extension.length);
  let candidate = base;
  let suffix = 2;

  while (true) {
    const owner = repository.findByFilePath(candidate);
    const occupiedByDatabase = owner && owner.id !== excludeId;
    const occupiedOnDisk = vault.existsSync(candidate) && owner?.id !== excludeId;
    if (!occupiedByDatabase && !occupiedOnDisk) return candidate;
    candidate = `${stem} (${suffix})${extension}`;
    suffix += 1;
  }
}

function duplicateTitle(title, folderId) {
  const base = `${title}（副本）`;
  let candidate = base;
  let suffix = 2;
  while (repository.findByTitle(candidate).some((note) => note.folderId === folderId)) {
    candidate = `${base} ${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function writeMarkdown(note) {
  vault.writeSync({
    id: note.id,
    title: note.title,
    content: note.content,
    filePath: noteFilePath(note),
    isPinned: note.isPinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    properties: note.properties,
  });
}

// properties 的三层读取：① contentHash 版本化的进程内缓存（零成本）；
// ② 投影列 properties_json（随投影落库，进程重启后仍然可用）；③ 回读磁盘
// 解析并惰性回填到投影列。磁盘始终是真源：frontmatter 变化必然改变
// content_hash，投影更新会连带动 properties_json。
const propertiesCache = new Map();
const PROPERTIES_CACHE_LIMIT = 10_000;

function readProperties(note) {
  const key = note?.id && note?.contentHash ? `${note.id}:${note.contentHash}` : null;
  if (key) {
    const cached = propertiesCache.get(key);
    if (cached) return cached;
  }

  let properties = null;
  if (note?.propertiesJson != null) {
    try {
      const parsed = JSON.parse(note.propertiesJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) properties = parsed;
    } catch {
      // 投影列损坏时回退磁盘解析
    }
  }

  if (properties === null) {
    const raw = note?.filePath ? vault.readRawSync(note.filePath) : null;
    properties = raw === null ? {} : parseMarkdownDocument(raw, note.filePath).properties ?? {};
    // 存量行的惰性回填：只回填带版本键（id + contentHash）的行，回填后
    // 该行不再触发读盘
    if (note?.id && note?.contentHash) {
      try {
        repository.backfillPropertiesJson(note.id, JSON.stringify(properties));
      } catch {
        // 回填失败只损失性能：下次读取会再试
      }
    }
  }

  if (key) {
    if (propertiesCache.size >= PROPERTIES_CACHE_LIMIT) propertiesCache.clear();
    propertiesCache.set(key, properties);
  }
  return properties;
}

/** 供 search 等模块复用同一份读取链路，避免各处重复读盘解析 frontmatter。 */
export function readNoteProperties(note) {
  return readProperties(note);
}

function normalizeProperties(properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  return Object.fromEntries(Object.entries(properties).sort(([left], [right]) => left.localeCompare(right)));
}

function propertiesEqual(left, right) {
  return JSON.stringify(normalizeProperties(left)) === JSON.stringify(normalizeProperties(right));
}

export function create({ id, title, content = '', folderId = null, properties = {} }) {
  assertFolderExists(folderId);

  if (id) {
    const existing = repository.findById(id);
    if (existing) return getDetail(existing.id);
  }

  const timestamp = nowIso();
  const noteId = id ?? randomUUID();
  const finalTitle = normalizeTitle(title, content);
  const filePath = allocateFilePath({ title: finalTitle, folderId });
  const draft = {
    id: noteId,
    title: finalTitle,
    content,
    folderId,
    filePath,
    isPinned: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    properties,
  };

  writeMarkdown(draft);
  try {
    withTransaction(() => {
      repository.insert({
        id: noteId,
        title: finalTitle,
        content,
        folderId,
        filePath,
        wordCount: computeWordCount(content),
        contentHash: hashDocument(draft),
        propertiesJson: JSON.stringify(normalizeProperties(properties)),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      tagsService.syncForNote(noteId, extractNoteTags(content, properties));
      linksService.rebuildForNote(noteId, content);
      linksService.claimForTitle(finalTitle, noteId);
    });
  } catch (error) {
    vault.removeSync(filePath);
    throw error;
  }

  return getDetail(noteId);
}

export function duplicate(id, { folderId } = {}) {
  const current = repository.findById(id);
  if (!current) throw new NotFoundError('Note not found');

  const targetFolderId = folderId === undefined ? current.folderId : folderId;
  assertFolderExists(targetFolderId);

  return create({
    title: duplicateTitle(current.title, targetFolderId),
    content: current.content,
    folderId: targetFolderId,
    properties: readProperties(current),
  });
}

export function update(id, patch) {
  const current = repository.findById(id);
  if (!current) throw new NotFoundError('笔记不存在');

  // 乐观锁：客户端携带读取时的 contentHash（expectedHash）时校验，
  // 防止两个窗口并发编辑后写者静默覆盖先写者
  if (patch.expectedHash && current.contentHash && patch.expectedHash !== current.contentHash) {
    throw new ConflictError('笔记已在其他窗口被修改，请刷新后再保存');
  }

  const oldFilePath = noteFilePath(current);
  const nextTitle = patch.title === undefined ? current.title : normalizeTitle(patch.title, patch.content ?? current.content);
  const nextContent = patch.content === undefined ? current.content : patch.content;
  const nextFolderId = patch.folderId === undefined ? current.folderId : patch.folderId;
  const nextPinned = patch.isPinned === undefined ? current.isPinned : patch.isPinned;
  const currentProperties = readProperties(current);
  const nextProperties = patch.properties === undefined ? currentProperties : patch.properties;

  assertFolderExists(nextFolderId);

  const titleChanged = nextTitle !== current.title;
  const contentChanged = nextContent !== current.content;
  const folderChanged = nextFolderId !== current.folderId;
  const pinnedChanged = nextPinned !== current.isPinned;
  const propertiesChanged = !propertiesEqual(nextProperties, currentProperties);
  // 遗留行（file_path 为 NULL 的迁移前数据）首次回填路径时也必须走冲突分配：
  // 派生路径可能已被其他笔记占用，直接采用会把对方文件覆写掉
  const backfillFilePath = !current.filePath;
  const nextFilePath = titleChanged || folderChanged || backfillFilePath
    ? allocateFilePath({ title: nextTitle, folderId: nextFolderId }, { excludeId: id })
    : oldFilePath;
  const filePathChanged = nextFilePath !== oldFilePath || backfillFilePath;

  if (!titleChanged && !contentChanged && !folderChanged && !pinnedChanged && !propertiesChanged && !filePathChanged) {
    return getDetail(id);
  }

  const updatedAt = nowIso();
  const nextNote = {
    ...current,
    title: nextTitle,
    content: nextContent,
    folderId: nextFolderId,
    filePath: nextFilePath,
    isPinned: nextPinned,
    wordCount: contentChanged ? computeWordCount(nextContent) : current.wordCount,
    updatedAt,
    properties: nextProperties,
  };

  // 历史快照只是附属数据，写失败（如 .lattice/history 不可写）不应阻断保存
  if (titleChanged || contentChanged || propertiesChanged) {
    try {
      historyStore.createSnapshot(current);
    } catch {
      // 下一次成功的保存会补上快照
    }
  }

  // 改名/移动走「内容先写旧路径 → 原子 rename 到新路径」，而不是「写新文件 → 删旧文件」：
  // 全程同一 id 只存在一个文件，watcher 不会在间隙里生成重复投影；Windows 上旧文件被
  // 占用（网盘/杀软/预览窗格）时 rename 明确失败并整体回滚——旧行为是事务提交后才删旧
  // 文件，删除失败会留下同 id 的两个文件，观感上就是「改名成功又自己变回去」。
  // 「写旧路径再 rename」只适用于本笔记在盘上确有文件的情形；遗留行没有
  // 已知路径，直接写新分配的路径即可，绝不能碰派生路径上的他人文件。
  const renamedOnDisk = filePathChanged && current.filePath && vault.existsSync(oldFilePath);
  if (renamedOnDisk) {
    writeMarkdown({ ...nextNote, filePath: oldFilePath });
    let moved = false;
    let moveError = null;
    for (let attempt = 0; attempt < 3 && !moved; attempt += 1) {
      try {
        vault.moveSync(oldFilePath, nextFilePath);
        moved = true;
      } catch (error) {
        moveError = error;
        sleepSync(80);
      }
    }
    if (!moved) {
      try {
        writeMarkdown({ ...current, filePath: oldFilePath, properties: currentProperties });
      } catch {
        // 磁盘恢复失败也不阻断报错：下一次全量同步会收敛投影
      }
      throw new ConflictError(`文件正被其他程序占用，无法重命名（${moveError?.code ?? moveError?.message ?? '未知错误'}）`);
    }
  } else {
    writeMarkdown(nextNote);
  }

  try {
    withTransaction(() => {
      repository.update(id, {
        title: nextTitle,
        content: nextContent,
        folderId: nextFolderId,
        filePath: nextFilePath,
        isPinned: nextPinned,
        wordCount: nextNote.wordCount,
        contentHash: hashDocument({ ...nextNote, filePath: nextFilePath }),
        propertiesJson: JSON.stringify(normalizeProperties(nextProperties)),
        updatedAt,
      });
      if (contentChanged || propertiesChanged) {
        tagsService.syncForNote(id, extractNoteTags(nextContent, nextProperties));
      }
      if (contentChanged) {
        linksService.rebuildForNote(id, nextContent);
      }
      // 删光正文标签后 0 引用的标签要同步清理：只靠 titleChanged 清会与
      // vault 事件路径（sync.js）的行为不一致，标签列表出现幽灵标签
      if (contentChanged || propertiesChanged) {
        tagsService.pruneOrphans();
      }
      if (titleChanged) {
        // 旧标题的链接先按文本重新解析归属（与外部编辑改名路径一致），再认领新标题
        linksService.releaseStaleLinks(id, nextTitle);
        linksService.claimForTitle(nextTitle, id);
        tagsService.pruneOrphans();
      }
    });
  } catch (error) {
    try {
      if (renamedOnDisk && vault.existsSync(nextFilePath)) vault.moveSync(nextFilePath, oldFilePath);
      else if (nextFilePath !== oldFilePath) vault.removeSync(nextFilePath);
      // 遗留行的旧派生路径可能属于其他笔记，回写会把对方文件覆写掉
      if (current.filePath) {
        writeMarkdown({ ...current, filePath: oldFilePath, properties: currentProperties });
      }
    } catch {
      // Preserve the original database error. The next vault scan can rebuild the projection.
    }
    throw error;
  }

  return getDetail(id);
}

export function remove(id, { replacementId = null } = {}) {
  const current = repository.findById(id);
  if (!current) return { id, deleted: false };
  const oldFilePath = noteFilePath(current);
  const raw = vault.readRawSync(oldFilePath);

  vault.removeSync(oldFilePath);
  try {
    withTransaction(() => {
      if (replacementId && replacementId !== id) linksRepository.reassignTarget(id, replacementId);
      repository.remove(id);
      tagsService.pruneOrphans();
    });
  } catch (error) {
    if (raw !== null) vault.writeRawSync(oldFilePath, raw);
    throw error;
  }
  // 外键级联清掉的只有投影表；向量索引（note_chunks/ai_index_state）必须显式移除，
  // 否则已删内容会继续留在语义检索的内存缓存里被召回
  try {
    removeNoteIndexes([id]);
  } catch {
    // 索引清理失败不回滚删除；下次任意写入触发 indexVersion 递增前，最多短暂残留
  }
  return { id, deleted: true };
}

export function getDetail(id) {
  const note = repository.findById(id);
  if (!note) throw new NotFoundError('Note not found');

  const tags = tagsRepository.findTagsForNotes([id]).get(id) ?? [];
  const { outgoing, backlinks } = linksService.describeForNote(id);
  const filePath = noteFilePath(note);
  return { ...note, filePath, properties: readProperties({ ...note, filePath }), tags, outgoing, backlinks };
}

export function list(options) {
  const inboxStatus = options.inboxStatus;
  const hasInboxFilter = inboxStatus !== undefined;
  const { items, total } = repository.list({ ...options, paginate: !hasInboxFilter });
  const enrichedItems = items.map((item) => {
    const filePath = noteFilePath(item);
    return {
      ...item,
      filePath,
      properties: readProperties({ ...item, filePath }),
    };
  });
  const filteredItems = hasInboxFilter
    ? enrichedItems.filter((item) => item.properties?.type === 'inbox'
      && (inboxStatus === 'all' || item.properties?.status === inboxStatus))
    : enrichedItems;
  const visibleItems = hasInboxFilter
    ? filteredItems.slice(options.offset, options.offset + options.limit)
    : filteredItems;
  const ids = visibleItems.map((item) => item.id);
  const tagMap = tagsRepository.findTagsForNotes(ids);
  const { outgoing, incoming } = linksService.countsForNotes(ids);

  return {
    items: visibleItems.map((item) => ({
      ...item,
      tags: tagMap.get(item.id) ?? [],
      outgoingCount: outgoing.get(item.id) ?? 0,
      backlinkCount: incoming.get(item.id) ?? 0,
    })),
    total: hasInboxFilter ? filteredItems.length : total,
  };
}

export function index() {
  return repository.listIndex().map((item) => ({
    ...item,
    properties: readProperties(item),
  }));
}

export function statistics() {
  return repository.statistics();
}

/** 同步代码里的短等待：给 Windows 文件锁（杀软扫描等）一点释放时间。 */
function sleepSync(milliseconds) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    // 环境不支持时退化为忙等
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) { /* spin */ }
  }
}

export function listHistory(id) {
  const note = repository.findById(id);
  if (!note) throw new NotFoundError('Note not found');
  return {
    items: historyStore.listSnapshots(id),
    currentHash: historyStore.currentHash(note),
  };
}

export function getHistoryVersion(id, version) {
  const note = repository.findById(id);
  if (!note) throw new NotFoundError('Note not found');
  const snapshot = historyStore.readSnapshot(id, version);
  historyStore.assertSnapshotMatchesHash(snapshot);
  const parsed = parseMarkdownDocument(snapshot.raw, note.filePath ?? `${note.title}.md`);
  return {
    version: snapshot.version,
    hash: snapshot.hash,
    createdAt: snapshot.createdAt,
    title: parsed.title,
    content: parsed.content,
    isPinned: parsed.isPinned,
    properties: parsed.properties,
  };
}

export function restoreHistory(id, version, { expectedCurrentHash } = {}) {
  const current = repository.findById(id);
  if (!current) throw new NotFoundError('Note not found');

  const currentHash = historyStore.currentHash(current);
  if (expectedCurrentHash && expectedCurrentHash !== currentHash) {
    throw new ConflictError('笔记已被其他操作修改，请重新加载后再恢复');
  }

  const snapshot = historyStore.readSnapshot(id, version);
  historyStore.assertSnapshotMatchesHash(snapshot);
  const parsed = parseMarkdownDocument(snapshot.raw, current.filePath ?? `${current.title}.md`);
  return update(id, {
    title: parsed.title,
    content: parsed.content,
    isPinned: parsed.isPinned,
    properties: parsed.properties,
  });
}
