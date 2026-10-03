/**
 * 标签服务层。
 * 标签是正文派生的：保存笔记时按 #标签 语法全量重建关联，
 * 因此不存在「手工维护标签与正文不一致」的问题。
 */
import { randomUUID } from 'node:crypto';
import { NotFoundError } from '../../lib/errors.js';
import { nowIso } from '../../lib/time.js';
import * as repository from './tags.repository.js';

export function list() {
  return repository.findAllWithCounts();
}

/** 按标签名取关联笔记（MCP search_by_tag 使用）；空名返回空数组。 */
export function notesByTag(name) {
  const trimmed = String(name ?? '').trim();
  return trimmed ? repository.findNotesByTag(trimmed) : [];
}

export function getById(id) {
  const tag = repository.findById(id);
  if (!tag) throw new NotFoundError('标签不存在');
  return tag;
}

export function remove(id) {
  getById(id);
  repository.remove(id);
  return { deleted: true };
}

/**
 * 把笔记的标签关联重建为给定的标签集合。
 * 必须在事务内调用（由 notes.service 统一开启事务）。
 * @param {string} noteId
 * @param {string[]} names 已归一化的标签名
 */
export function syncForNote(noteId, names) {
  repository.clearNoteTags(noteId);

  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const existing = repository.findIdsByNames(unique);

  for (const name of unique) {
    const key = name.toLowerCase();
    let tagId = existing.get(key);
    if (!tagId) {
      tagId = repository.insert({ id: randomUUID(), name, createdAt: nowIso() }).id;
      existing.set(key, tagId);
    }
    repository.attachToNote(noteId, tagId);
  }

  return unique;
}

/** 清理已经没有任何笔记引用的孤儿标签 */
export function pruneOrphans() {
  const orphans = repository.findAllWithCounts().filter((tag) => tag.noteCount === 0);
  for (const tag of orphans) repository.remove(tag.id);
  return orphans.length;
}
