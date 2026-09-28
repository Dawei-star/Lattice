import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/index.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { computeWordCount, extractTags, inferTitle } from '../../lib/markdown.js';
import { nowIso } from '../../lib/time.js';
import * as foldersRepository from '../folders/folders.repository.js';
import * as linksService from '../links/links.service.js';
import * as tagsRepository from '../tags/tags.repository.js';
import * as tagsService from '../tags/tags.service.js';
import * as repository from './notes.repository.js';
import { config } from '../../config/index.js';
import { VaultAdapter } from '../../vault/vault.adapter.js';
import { hashDocument } from '../../vault/markdown.js';

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

function safeFilePart(value) {
  return String(value || '未命名笔记')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || '未命名笔记';
}

function folderPath(folderId) {
  const parts = [];
  const visited = new Set();
  let current = folderId ? foldersRepository.findById(folderId) : null;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    parts.unshift(safeFilePart(current.name));
    current = current.parentId ? foldersRepository.findById(current.parentId) : null;
  }
  return parts.join('/');
}

function derivedNoteFilePath(note) {
  const directory = folderPath(note.folderId);
  return `${directory ? `${directory}/` : ''}${safeFilePart(note.title)}.md`;
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
  });
}

export function create({ id, title, content = '', folderId = null }) {
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
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      tagsService.syncForNote(noteId, extractTags(content));
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
  if (!current) throw new NotFoundError('笔记不存在');

  const targetFolderId = folderId === undefined ? current.folderId : folderId;
  assertFolderExists(targetFolderId);

  return create({
    title: duplicateTitle(current.title, targetFolderId),
    content: current.content,
    folderId: targetFolderId,
  });
}

export function update(id, patch) {
  const current = repository.findById(id);
  if (!current) throw new NotFoundError('笔记不存在');

  const oldFilePath = noteFilePath(current);
  const nextTitle = patch.title === undefined ? current.title : normalizeTitle(patch.title, patch.content ?? current.content);
  const nextContent = patch.content === undefined ? current.content : patch.content;
  const nextFolderId = patch.folderId === undefined ? current.folderId : patch.folderId;
  const nextPinned = patch.isPinned === undefined ? current.isPinned : patch.isPinned;

  assertFolderExists(nextFolderId);

  const titleChanged = nextTitle !== current.title;
  const contentChanged = nextContent !== current.content;
  const folderChanged = nextFolderId !== current.folderId;
  const pinnedChanged = nextPinned !== current.isPinned;
  const nextFilePath = titleChanged || folderChanged
    ? allocateFilePath({ title: nextTitle, folderId: nextFolderId }, { excludeId: id })
    : oldFilePath;
  const filePathChanged = nextFilePath !== oldFilePath || !current.filePath;

  if (!titleChanged && !contentChanged && !folderChanged && !pinnedChanged && !filePathChanged) {
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
  };

  writeMarkdown(nextNote);
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
        updatedAt,
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
  } catch (error) {
    if (nextFilePath !== oldFilePath) vault.removeSync(nextFilePath);
    try {
      writeMarkdown({ ...current, filePath: oldFilePath });
    } catch {
      // Preserve the original database error. The next vault scan can rebuild the projection.
    }
    throw error;
  }

  if (oldFilePath !== nextFilePath) vault.removeSync(oldFilePath);
  return getDetail(id);
}

export function remove(id) {
  const current = repository.findById(id);
  if (!current) return { id, deleted: false };
  const oldFilePath = noteFilePath(current);
  const raw = vault.readRawSync(oldFilePath);

  vault.removeSync(oldFilePath);
  try {
    withTransaction(() => {
      repository.remove(id);
      tagsService.pruneOrphans();
    });
  } catch (error) {
    if (raw !== null) vault.writeRawSync(oldFilePath, raw);
    throw error;
  }
  return { id, deleted: true };
}

export function getDetail(id) {
  const note = repository.findById(id);
  if (!note) throw new NotFoundError('Note not found');

  const tags = tagsRepository.findTagsForNotes([id]).get(id) ?? [];
  const { outgoing, backlinks } = linksService.describeForNote(id);
  return { ...note, filePath: noteFilePath(note), tags, outgoing, backlinks };
}

export function list(options) {
  const { items, total } = repository.list(options);
  const ids = items.map((item) => item.id);
  const tagMap = tagsRepository.findTagsForNotes(ids);
  const { outgoing, incoming } = linksService.countsForNotes(ids);

  return {
    items: items.map((item) => ({
      ...item,
      filePath: noteFilePath(item),
      tags: tagMap.get(item.id) ?? [],
      outgoingCount: outgoing.get(item.id) ?? 0,
      backlinkCount: incoming.get(item.id) ?? 0,
    })),
    total,
  };
}

export function index() {
  return repository.listIndex();
}

export function statistics() {
  return repository.statistics();
}
