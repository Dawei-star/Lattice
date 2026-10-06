import { createHash } from 'node:crypto';
import * as linksRepository from '../links/links.repository.js';
import * as linksService from '../links/links.service.js';
import * as notesRepository from '../notes/notes.repository.js';
import * as notesService from '../notes/notes.service.js';
import * as tagsRepository from '../tags/tags.repository.js';

const DEFAULT_STALE_DAYS = 90;
const MAX_ITEMS = 100;
const SYSTEM_PROPERTIES = new Set(['type', 'status']);

/**
 * 生成可解释的、只读的 Vault 维护清单。
 * 所有结果都带路径或笔记 id，后续动作可以交给已有的操作预览管线。
 */
export function scan({ staleDays = DEFAULT_STALE_DAYS, limit = MAX_ITEMS } = {}) {
  const notes = notesRepository.listForHealth();
  const noteIds = notes.map((note) => note.id);
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const tagMap = tagsRepository.findTagsForNotes(noteIds);
  const { outgoing, incoming } = linksService.countsForNotes(noteIds);
  const propertiesById = new Map(notes.map((note) => [note.id, notesService.readNoteProperties(note)]));

  const inbox = notes
    .filter((note) => {
      const properties = propertiesById.get(note.id) ?? {};
      return properties.type === 'inbox' && properties.status !== 'processed';
    })
    .map((note) => noteFinding(note, {
      reason: `Inbox 中仍处于「${propertiesById.get(note.id)?.status ?? 'captured'}」状态`,
      status: propertiesById.get(note.id)?.status ?? 'captured',
    }))
    .slice(0, limit);

  const brokenLinks = buildBrokenLinks(noteById, limit);

  const isolated = notes
    .filter((note) => (outgoing.get(note.id) ?? 0) === 0 && (incoming.get(note.id) ?? 0) === 0)
    .map((note) => noteFinding(note, {
      reason: '没有出链，也没有其他笔记引用它',
      outgoingCount: 0,
      backlinkCount: 0,
    }))
    .slice(0, limit);

  const cutoff = Date.now() - staleDays * 86_400_000;
  const stale = notes
    .filter((note) => {
      const properties = propertiesById.get(note.id) ?? {};
      const updatedAt = Date.parse(note.updatedAt);
      return properties.type !== 'inbox'
        && Number.isFinite(updatedAt)
        && updatedAt < cutoff
        && (incoming.get(note.id) ?? 0) === 0;
    })
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
    .map((note) => noteFinding(note, {
      reason: `已超过 ${staleDays} 天未更新，且没有反向链接`,
      ageDays: Math.max(0, Math.floor((Date.now() - Date.parse(note.updatedAt)) / 86_400_000)),
      backlinkCount: 0,
    }))
    .slice(0, limit);

  const duplicates = findDuplicates(notes, limit);

  const incomplete = notes
    .map((note) => {
      const properties = propertiesById.get(note.id) ?? {};
      const tags = tagMap.get(note.id) ?? [];
      const missing = [];
      if (!note.folderId) missing.push('未归入目录');
      if (!tags.length) missing.push('没有标签');
      if (!Object.keys(properties).some((key) => !SYSTEM_PROPERTIES.has(key))) missing.push('缺少自定义属性');
      if (!missing.length) return null;
      return noteFinding(note, {
        reason: missing.join('、'),
        missing,
        tags: tags.map((tag) => tag.name),
      });
    })
    .filter(Boolean)
    .slice(0, limit);

  const categories = { inbox, brokenLinks, isolated, stale, duplicates, incomplete };
  const counts = Object.fromEntries(Object.entries(categories).map(([key, items]) => [key, items.length]));

  return {
    scannedAt: new Date().toISOString(),
    noteCount: notes.length,
    staleDays,
    limits: { perCategory: limit },
    summary: {
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      counts,
    },
    categories,
  };
}

function buildBrokenLinks(noteById, limit) {
  const groups = new Map();
  for (const row of linksRepository.listDanglingDetails()) {
    const key = row.targetTitle.toLocaleLowerCase();
    if (!groups.has(key)) groups.set(key, { targetTitle: row.targetTitle, sources: [] });
    groups.get(key).sources.push({
      id: row.sourceId,
      title: row.sourceTitle,
      path: row.sourcePath,
    });
  }

  return [...groups.values()]
    .sort((left, right) => right.sources.length - left.sources.length || left.targetTitle.localeCompare(right.targetTitle))
    .slice(0, limit)
    .map((group) => ({
      id: `broken-link:${group.targetTitle}`,
      kind: 'broken-link',
      targetTitle: group.targetTitle,
      referenceCount: group.sources.length,
      sources: group.sources.filter((source) => noteById.has(source.id)),
      reason: `有 ${group.sources.length} 篇笔记引用「${group.targetTitle}」，但目标笔记尚不存在`,
    }));
}

function findDuplicates(notes, limit) {
  const groups = new Map();
  for (const note of notes) {
    const titleKey = normalizeText(note.title);
    const bodyKey = fingerprint(note.content);
    if (titleKey) addDuplicateCandidate(groups, `title:${titleKey}`, note, '标题相同');
    if (bodyKey) addDuplicateCandidate(groups, `body:${bodyKey}`, note, '正文高度一致');
  }

  const emitted = new Set();
  return [...groups.values()]
    .filter((group) => group.notes.length > 1)
    .map((group) => {
      const noteIds = group.notes.map((note) => note.id).sort();
      const pairKey = noteIds.join('|');
      if (emitted.has(pairKey)) return null;
      emitted.add(pairKey);
      const evidence = [...group.evidence];
      const confidence = evidence.length > 1 ? 'high' : 'review';
      return {
        id: `duplicate:${createHash('sha1').update(pairKey).digest('hex').slice(0, 12)}`,
        kind: 'duplicate',
        noteIds,
        notes: group.notes.map((note) => noteFinding(note, { reason: evidence.join('、') })),
        evidence,
        confidence,
        reason: confidence === 'high' ? '标题与正文都高度一致' : evidence[0],
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

function addDuplicateCandidate(groups, key, note, evidence) {
  if (!groups.has(key)) groups.set(key, { notes: [], evidence: new Set() });
  const group = groups.get(key);
  group.notes.push(note);
  group.evidence.add(evidence);
}

function noteFinding(note, extra = {}) {
  return {
    id: note.id,
    kind: 'note',
    title: note.title,
    path: note.filePath || `${note.title}.md`,
    folderId: note.folderId,
    updatedAt: note.updatedAt,
    wordCount: note.wordCount,
    ...extra,
  };
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function fingerprint(content) {
  const normalized = normalizeText(content);
  if (normalized.length < 20) return '';
  return createHash('sha1').update(normalized).digest('hex');
}
