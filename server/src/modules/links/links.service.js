/**
 * 双向链接服务层。
 *
 * 设计要点：链接关系是「正文派生数据」，不是独立事实。
 * 因此每次保存笔记都按正文全量重建其出链（先删后插），
 * 避免增量 diff 引入的不一致。
 */
import { extractWikiLinks } from '../../lib/markdown.js';
import { nowIso } from '../../lib/time.js';
import * as notesRepository from '../notes/notes.repository.js';
import * as repository from './links.repository.js';

/**
 * 解析一个标题当前对应的笔记。同名时取最近更新的一篇。
 * @param {string} title
 */
function resolveTitle(title) {
  const matches = notesRepository.findByTitle(title);
  return matches.length > 0 ? matches[0].id : null;
}

/**
 * 按正文重建某篇笔记的全部出链。必须在事务内调用。
 * @param {string} noteId
 * @param {string} content
 * @returns {number} 写入的链接条数
 */
export function rebuildForNote(noteId, content) {
  const links = extractWikiLinks(content);
  repository.deleteBySource(noteId);

  const timestamp = nowIso();
  for (const link of links) {
    repository.insert({
      sourceNoteId: noteId,
      targetTitle: link.target,
      targetNoteId: resolveTitle(link.target),
      createdAt: timestamp,
    });
  }

  return links.length;
}

/**
 * 笔记新建或改名后，把指向该标题的悬空链接认领过来。
 * @returns {number} 被认领的链接条数
 */
export function claimForTitle(title, noteId) {
  return repository.claimDanglingLinks(title, noteId);
}

/** 某篇笔记的链接全景：出链 + 反链 */
export function describeForNote(noteId) {
  return {
    outgoing: repository.listOutgoing(noteId),
    backlinks: repository.listBacklinks(noteId),
  };
}

export function listDangling() {
  return repository.listDangling();
}

export function countsForNotes(noteIds) {
  return repository.countsForNotes(noteIds);
}

export function edges() {
  return repository.listEdges();
}
