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
 * 按正文重建某篇笔记的全部出链。必须在事务内调用。
 * @param {string} noteId
 * @param {string} content
 * @returns {number} 写入的链接条数
 */
export function rebuildForNote(noteId, content) {
  const links = extractWikiLinks(content);
  repository.deleteBySource(noteId);

  const timestamp = nowIso();
  // extractWikiLinks 已按小写去重；一次查询解析全部标题，避免逐链接 SELECT 的 N+1
  const owners = new Map();
  for (const row of notesRepository.findIdsByTitles(links.map((link) => link.target))) {
    if (!owners.has(row.title.toLowerCase())) owners.set(row.title.toLowerCase(), row.id);
  }
  for (const link of links) {
    repository.insert({
      sourceNoteId: noteId,
      targetTitle: link.target,
      targetNoteId: owners.get(link.target.toLowerCase()) ?? null,
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

/**
 * 笔记改名后，原本指向它的链接（target_note_id = 该笔记）的文本仍是旧标题，
 * 不能继续霸占指向关系：按链接文本重新解析归属，解析不到就退回悬空。
 * 必须在事务内调用。
 */
export function releaseStaleLinks(noteId, newTitle) {
  const normalizedNewTitle = newTitle.toLowerCase();
  for (const link of repository.listLinksPointingAt(noteId)) {
    if (link.targetTitle.toLowerCase() === normalizedNewTitle) continue;
    const owner = notesRepository.findByTitle(link.targetTitle)[0];
    repository.updateLinkTarget({ sourceNoteId: link.sourceNoteId, targetTitle: link.targetTitle, targetNoteId: owner?.id ?? null });
  }
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
