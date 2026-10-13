import assert from 'node:assert/strict';
import { mergeSavedNoteIntoCollection } from '../src/lib/note-state.js';

const current = [
  {
    id: 'note-1',
    title: '旧名字',
    folderId: 'folder-old',
    filePath: '旧名字.md',
    updatedAt: '2026-10-11T00:00:00.000Z',
    isPinned: false,
    wordCount: 3,
  },
  { id: 'note-2', title: '另一篇笔记', folderId: null },
];

const saved = {
  id: 'note-1',
  title: '新名字',
  folderId: 'folder-new',
  filePath: 'Projects/新名字.md',
  updatedAt: '2026-10-11T00:01:00.000Z',
  isPinned: true,
  wordCount: 8,
};

const next = mergeSavedNoteIntoCollection(current, saved);

assert.equal(next[0].title, '新名字');
assert.equal(next[0].filePath, 'Projects/新名字.md');
assert.equal(next[0].folderId, 'folder-new');
assert.equal(next[0].isPinned, true);
assert.equal(next[1].title, '另一篇笔记');
assert.deepEqual(current[0], {
  id: 'note-1',
  title: '旧名字',
  folderId: 'folder-old',
  filePath: '旧名字.md',
  updatedAt: '2026-10-11T00:00:00.000Z',
  isPinned: false,
  wordCount: 3,
});

console.log('note list state rename regression: PASS');
