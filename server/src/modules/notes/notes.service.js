/**
 * 笔记服务层：业务规则与事务编排。
 *
 * 一次「保存笔记」实际上要保证三件事同时成立：
 *   1. 笔记本体落库
 *   2. 标签关联与正文中的 #标签 一致
 *   3. 出链与正文中的 [[双链]] 一致
 * 三者必须原子完成，因此统一包在一个事务里。
 */
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/index.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { computeWordCount, extractTags, inferTitle } from '../../lib/markdown.js';
import { nowIso } from '../../lib/time.js';
import * as foldersRepository from '../folders/folders.repository.js';
import * as linksService from '../links/links.service.js';
import * as tagsRepository from '../tags/tags.repository.js';
import * as tagsService from '../tags/tags.service.js';
import * as versionsService from '../versions/versions.service.js';
import * as repository from './notes.repository.js';

const MAX_TITLE_LENGTH = 200;

function normalizeTitle(rawTitle, fallbackContent) {
  const title = (rawTitle ?? '').trim() || inferTitle(fallbackContent);
  return title.slice(0, MAX_TITLE_LENGTH);
}

function assertFolderExists(folderId) {
  if (folderId && !foldersRepository.findById(folderId)) {
    throw new ValidationError('指定的目录不存在', [{ in: 'body', field: 'folderId', message: '目录不存在' }]);
  }
}

/**
 * 新建笔记。
 * 支持客户端传入 id —— 这样「请求已到达但响应丢失」导致的自动重试不会产生重复笔记，
 * 即 POST /api/notes 具备幂等语义。
 */
export function create({ id, title, content = '', folderId = null }) {
  assertFolderExists(folderId);

  if (id) {
    const existing = repository.findById(id);
    if (existing) return getDetail(existing.id);
  }

  const timestamp = nowIso();
  const noteId = id ?? randomUUID();
  const finalTitle = normalizeTitle(title, content);

  const note = withTransaction(() => {
    const created = repository.insert({
      id: noteId,
      title: finalTitle,
      content,
      folderId,
      wordCount: computeWordCount(content),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    tagsService.syncForNote(noteId, extractTags(content));
    linksService.rebuildForNote(noteId, content);
    // 这篇笔记可能正是别人 [[双链]] 里引用了但还不存在的目标，这里一并认领
    linksService.claimForTitle(finalTitle, noteId);

    return created;
  });

  return getDetail(note.id);
}

export function update(id, patch) {
  const current = repository.findById(id);
  if (!current) throw new NotFoundError('笔记不存在');

  const nextTitle =
    patch.title === undefined ? current.title : normalizeTitle(patch.title, patch.content ?? current.content);
  const nextContent = patch.content === undefined ? current.content : patch.content;
  const nextFolderId = patch.folderId === undefined ? current.folderId : patch.folderId;
  const nextPinned = patch.isPinned === undefined ? current.isPinned : patch.isPinned;

  assertFolderExists(nextFolderId);

  const titleChanged = nextTitle !== current.title;
  const contentChanged = nextContent !== current.content;
  const folderChanged = nextFolderId !== current.folderId;
  const pinnedChanged = nextPinned !== current.isPinned;

  if (!titleChanged && !contentChanged && !folderChanged && !pinnedChanged) {
    // 没有任何实质变化时不写库，也不刷新 updated_at（避免自动保存空转改时间戳）
    return getDetail(id);
  }

  withTransaction(() => {
    // 内容/标题发生实质变化时，先把「将被覆盖的旧状态」存成一条历史快照，
    // 再落库。快照内部按最小间隔节流并对旧版本淘汰，避免自动保存刷屏。
    if (titleChanged || contentChanged) {
      versionsService.snapshot(current);
    }

    repository.update(id, {
      title: nextTitle,
      content: nextContent,
      folderId: nextFolderId,
      isPinned: nextPinned,
      wordCount: contentChanged ? computeWordCount(nextContent) : current.wordCount,
      updatedAt: nowIso(),
    });

    if (contentChanged) {
      tagsService.syncForNote(id, extractTags(nextContent));
      linksService.rebuildForNote(id, nextContent);
    }
    if (titleChanged) {
      linksService.claimForTitle(nextTitle, id);
      tagsService.pruneOrphans();
    }
  });

  return getDetail(id);
}

/**
 * 删除笔记。刻意设计为幂等：目标已不存在时返回 deleted=false 而非 404，
 * 这样 5xx 触发的客户端自动重试不会给用户抛出假错误。
 */
export function remove(id) {
  if (!repository.findById(id)) return { id, deleted: false };

  withTransaction(() => {
    // notes 的删除会级联清理 note_tags 与以本笔记为源头的 links；
    // 以本笔记为目标的 links 会因外键 ON DELETE SET NULL 自动变回悬空链接
    repository.remove(id);
    tagsService.pruneOrphans();
  });

  return { id, deleted: true };
}

/** 单篇笔记的完整视图：本体 + 标签 + 出链 + 反链 */
export function getDetail(id) {
  const note = repository.findById(id);
  if (!note) throw new NotFoundError('笔记不存在');

  const tags = tagsRepository.findTagsForNotes([id]).get(id) ?? [];
  const { outgoing, backlinks } = linksService.describeForNote(id);

  return { ...note, tags, outgoing, backlinks };
}

export function list(options) {
  const { items, total } = repository.list(options);
  const ids = items.map((item) => item.id);

  const tagMap = tagsRepository.findTagsForNotes(ids);
  const { outgoing, incoming } = linksService.countsForNotes(ids);

  return {
    items: items.map((item) => ({
      ...item,
      tags: tagMap.get(item.id) ?? [],
      outgoingCount: outgoing.get(item.id) ?? 0,
      backlinkCount: incoming.get(item.id) ?? 0,
    })),
    total,
  };
}

/**
 * 全量笔记索引（不含正文）。一次拉取即可驱动前端的快速切换、
 * 双链标题解析与孤岛检测，避免为每个链接单独发请求。
 */
export function index() {
  return repository.listIndex();
}

export function statistics() {
  return repository.statistics();
}
