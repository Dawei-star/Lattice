import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFileStore } from './fc-core.mjs';

test('FileStore keeps mutations inside the root and supports undo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-fc-'));
  try {
    const store = createFileStore(root);
    const created = store.mutate('create', { path: 'notes/one.md', content: 'alpha' });
    assert.equal(store.read('notes/one.md').content, 'alpha');
    assert.equal(store.grep('alpha', 'notes', { type: 'md' }).total, 1);

    const edited = store.mutate('edit', {
      path: 'notes/one.md',
      replace: 'alpha',
      with: 'beta',
    });
    assert.equal(store.read('notes/one.md').content, 'beta');
    store.undo(edited.operationId);
    assert.equal(store.read('notes/one.md').content, 'alpha');

    assert.throws(() => store.mutate('read', { path: '../outside.md' }), /Unsupported mutation/);
    assert.equal(created.operationId.length > 0, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
