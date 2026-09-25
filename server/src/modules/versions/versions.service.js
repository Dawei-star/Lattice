/**
 * 笔记版本历史服务。
 *
 * 版本 = 「被覆盖前的旧状态」快照。notes 表始终保存最新态，
 * note_versions 保存历史。两个动作：
 *   - snapshot()：保存前把即将被覆盖的当前状态存一条（由 notes.service.update 在事务内调用）；
 *   - restore()：把某条历史写回笔记（本身也先快照当前态，令恢复可撤销）。
 *
 * 抑制历史刷屏：距上一条快照不足 VERSION_INTERVAL_MS 则跳过（dedup 优先于时间）。
 * force 只解除时间节流，不解除「与最新一条内容相同就不存」的去重。
 */
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { withTransaction } from '../../db/index.js';
import { NotFoundError } from '../../lib/errors.js';
import { computeWordCount, extractTags } from '../../lib/markdown.js';
import { nowIso } from '../../lib/time.js';
import * as notesRepository from '../notes/notes.repository.js';
import * as linksService from '../links/links.service.js';
import * as tagsService from '../tags/tags.service.js';
import * as repository from './versions.repository.js';

function shouldSnapshot(note, latest, { force }) {
  if (!latest) return true; // 首条历史，无条件留
  // 与最近一条内容一致则去重（force 也不例外）
  if (latest.content === note.content && latest.title === note.title) return false;
  if (force) return true;
  const lastMs = Date.parse(latest.createdAt) || 0;
  return Date.now() - lastMs >= config.versionIntervalMs;
}

/**
 * 为「即将被覆盖的当前笔记状态」存一条历史快照，并按保留上限淘汰最旧的。
 * 必须在调用方事务内执行。
 * @param {{ id: string, title: string, content: string, wordCount: number }} note
 * @param {{ force?: boolean }} [options]
 * @returns {boolean} 是否真正写入了一条快照
 */
export function snapshot(note, { force = false } = {}) {
  const latest = repository.latestByNote(note.id);
  if (!shouldSnapshot(note, latest, { force })) return false;

  repository.insert({
    id: randomUUID(),
    noteId: note.id,
    title: note.title,
    content: note.content,
    wordCount: note.wordCount ?? computeWordCount(note.content),
    createdAt: nowIso(),
  });
  repository.trimToLatest(note.id, config.versionRetention);
  return true;
}

/** 某篇笔记的历史列表（不含正文） */
export function listForNote(noteId) {
  if (!notesRepository.findById(noteId)) throw new NotFoundError('笔记不存在');
  return repository.listByNote(noteId);
}

/** 读取单条历史全文，并校验其确属该笔记（防越权读取别的笔记版本） */
export function getVersion(noteId, versionId) {
  const version = repository.findById(versionId);
  if (!version || version.noteId !== noteId) throw new NotFoundError('版本不存在');
  return version;
}

/**
 * 恢复某条历史为该笔记的当前内容。
 * 先把当前态强制快照（使「恢复」本身可撤销），再把历史内容写回并同步派生数据。
 * @returns {{ note: ReturnType<typeof notesRepository.findById>, restoredFrom: string }}
 */
export function restore(noteId, versionId) {
  const current = notesRepository.findById(noteId);
  if (!current) throw new NotFoundError('笔记不存在');

  const version = getVersion(noteId, versionId);
  if (version.content === current.content && version.title === current.title) {
    // 当前已是该历史内容，无需恢复
    return { note: current, restoredFrom: versionId, noop: true };
  }

  withTransaction(() => {
    snapshot(current, { force: true });
    notesRepository.update(noteId, {
      title: version.title,
      content: version.content,
      folderId: current.folderId,
      isPinned: current.isPinned,
      wordCount: computeWordCount(version.content),
      updatedAt: nowIso(),
    });
    linksService.rebuildForNote(noteId, version.content);
    tagsService.syncForNote(noteId, extractTags(version.content));
    tagsService.pruneOrphans();
  });

  return { note: notesRepository.findById(noteId), restoredFrom: versionId, noop: false };
}
