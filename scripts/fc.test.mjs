import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from './fc-core.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-fc-'));
  return { root, store: createFileStore(root) };
}

test('dry-run does not write and edit replaces exact text', () => {
  const { root, store } = fixture();
  fs.writeFileSync(path.join(root, 'notes.md'), 'before\nkeep\n', 'utf8');

  const preview = store.mutate('edit', { path: 'notes.md', replace: 'before', with: 'after' }, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), 'before\nkeep\n');
  assert.match(preview.diff, /-before/);
  assert.match(preview.diff, /\+after/);

  const result = store.mutate('edit', { path: 'notes.md', replace: 'before', with: 'after' });
  assert.equal(result.undoable, true);
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), 'after\nkeep\n');
});

test('delete is recoverable through the latest undo snapshot', () => {
  const { root, store } = fixture();
  fs.writeFileSync(path.join(root, 'remove.txt'), 'recover me', 'utf8');
  const result = store.mutate('delete', { path: 'remove.txt' });
  assert.equal(fs.existsSync(path.join(root, 'remove.txt')), false);
  assert.equal(fs.existsSync(path.join(root, '.fc', 'trash', result.operationId, 'files', '0.bin')), true);

  const undone = store.undo();
  assert.equal(undone.operationId, result.operationId);
  assert.equal(fs.readFileSync(path.join(root, 'remove.txt'), 'utf8'), 'recover me');
});

test('move and copy reject overwrites and undo move', () => {
  const { root, store } = fixture();
  fs.writeFileSync(path.join(root, 'source.txt'), 'value', 'utf8');
  fs.writeFileSync(path.join(root, 'existing.txt'), 'existing', 'utf8');
  const copyPreview = store.mutate('copy', { path: 'missing.txt', targetPath: 'copy.txt' }, { dryRun: true });
  assert.deepEqual(copyPreview.changes.map((change) => change.path), ['missing.txt', 'copy.txt']);
  assert.throws(() => store.mutate('copy', { path: 'source.txt', targetPath: 'existing.txt' }), /Target already exists/);

  const result = store.mutate('move', { path: 'source.txt', targetPath: 'nested/moved.txt' });
  assert.equal(fs.existsSync(path.join(root, 'source.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'nested', 'moved.txt'), 'utf8'), 'value');
  store.undo(result.operationId);
  assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'value');
  assert.equal(fs.existsSync(path.join(root, 'nested', 'moved.txt')), false);
});

test('find and grep return portable paths and line numbers', () => {
  const { root, store } = fixture();
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'one.md'), 'alpha\nneedle\n', 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'two.txt'), 'needle\n', 'utf8');
  fs.writeFileSync(path.join(root, 'root.md'), 'root\n', 'utf8');

  assert.deepEqual(store.find('**/*.md').items.map((item) => item.path), ['docs/one.md', 'root.md']);
  assert.deepEqual(store.find('*.md', 'docs').items.map((item) => item.path), ['docs/one.md']);
  assert.deepEqual(store.grep('needle', 'docs', { type: 'md' }).items.map((item) => ({ path: item.path, line: item.line })), [{ path: 'docs/one.md', line: 2 }]);
});

test('stat reports file state and batch execution tracks each operation', () => {
  const { root, store } = fixture();
  fs.mkdirSync(path.join(root, 'inbox'));
  fs.writeFileSync(path.join(root, 'inbox', 'source.txt'), 'value', 'utf8');

  const file = store.stat('inbox/source.txt');
  assert.equal(file.exists, true);
  assert.equal(file.type, 'file');
  assert.equal(file.size, 5);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(store.stat('missing.txt'), { path: 'missing.txt', exists: false, type: 'missing' });

  const actions = [
    { type: 'mkdir', path: 'archive' },
    { type: 'move', path: 'inbox/source.txt', targetPath: 'archive/source.txt' },
  ];
  const preview = store.previewBatch(actions);
  assert.equal(preview.total, 2);
  assert.match(preview.planHash, /^[a-f0-9]{64}$/);
  const result = store.mutateBatch(actions, { planHash: preview.planHash });
  assert.equal(result.total, 2);
  assert.equal(result.operationIds.length, 2);
  assert.equal(fs.readFileSync(path.join(root, 'archive', 'source.txt'), 'utf8'), 'value');
  assert.equal(new Set(store.log(10).filter((entry) => entry.batchId).map((entry) => entry.batchId)).size, 1);

  store.undo(result.operationIds[1]);
  store.undo(result.operationIds[0]);
  assert.equal(fs.readFileSync(path.join(root, 'inbox', 'source.txt'), 'utf8'), 'value');
  assert.equal(fs.existsSync(path.join(root, 'archive')), false);
});

test('batch plan hash rejects files changed after preview', () => {
  const { root, store } = fixture();
  const actions = [{ type: 'write', path: 'note.txt', content: 'planned' }];
  const preview = store.previewBatch(actions);
  fs.writeFileSync(path.join(root, 'note.txt'), 'changed externally', 'utf8');

  assert.throws(() => store.mutateBatch(actions, { planHash: preview.planHash }), /Batch plan hash mismatch/);
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'changed externally');
});

test('batch reports completed operations when a later operation fails', () => {
  const { root, store } = fixture();
  const actions = [
    { type: 'write', path: 'created.txt', content: 'done' },
    { type: 'delete', path: 'missing.txt' },
  ];

  assert.throws(() => store.mutateBatch(actions), (error) => {
    assert.equal(error.code, 'BATCH_PARTIAL_FAILURE');
    assert.equal(error.details.completed.length, 1);
    assert.equal(error.details.completed[0].type, 'write');
    return true;
  });
  assert.equal(fs.readFileSync(path.join(root, 'created.txt'), 'utf8'), 'done');
});

test('undo refuses to remove a created directory after external content appears', () => {
  const { root, store } = fixture();
  const result = store.mutate('mkdir', { path: 'created' });
  fs.writeFileSync(path.join(root, 'created', 'external.txt'), 'keep', 'utf8');

  assert.throws(() => store.undo(result.operationId), /directory is not empty/);
  assert.equal(fs.readFileSync(path.join(root, 'created', 'external.txt'), 'utf8'), 'keep');
});

test('path traversal and reserved state directory are rejected', () => {
  const { store } = fixture();
  assert.throws(() => store.read('../outside.txt'), /traversal/i);
  assert.throws(() => store.read('.fc/audit.jsonl'), /reserved/i);
});

test('symbolic link parent paths are rejected when supported', (t) => {
  const { root, store } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-fc-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret', 'utf8');
  try {
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  } catch (error) {
    t.skip(`symbolic links unavailable: ${error.code ?? error.message}`);
    return;
  }

  assert.throws(() => store.read('linked/secret.txt'), /Symbolic links are not supported/);
  assert.throws(() => store.stat('linked/secret.txt'), /Symbolic links are not supported/);
});
