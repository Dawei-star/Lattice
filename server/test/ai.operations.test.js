import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-operations-'));
const vaultDir = path.join(runtimeRoot, 'vault');
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.VAULT_DIR = vaultDir;
process.env.NODE_ENV = 'test';
fs.mkdirSync(vaultDir, { recursive: true });

const operations = await import('../src/modules/ai/ai.operations.js');

test('preview returns a plan hash and execute requires it for writes', async () => {
  const file = path.join(vaultDir, 'plan.md');
  fs.writeFileSync(file, '# Original\n', 'utf8');
  const actions = [{ type: 'update', path: 'plan.md', content: '# Updated\n' }];
  const preview = operations.preview(actions);

  assert.match(preview.planHash, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () => operations.execute(actions, { confirmed: true }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    () => operations.execute(actions, { confirmed: true, planHash: '0'.repeat(64) }),
    (error) => error.status === 409,
  );
});

test('execute rejects a file changed after preview', async () => {
  const file = path.join(vaultDir, 'changed.md');
  fs.writeFileSync(file, '# Before\n', 'utf8');
  const actions = [{ type: 'update', path: 'changed.md', content: '# Planned\n' }];
  const preview = operations.preview(actions);
  fs.writeFileSync(file, '# Changed elsewhere\n', 'utf8');

  await assert.rejects(
    () => operations.execute(actions, { confirmed: true, planHash: preview.planHash }),
    (error) => error.status === 409,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '# Changed elsewhere\n');
});

test('internal agent approval can execute without a preview hash', async () => {
  const actions = [{ type: 'create', path: 'agent.md', content: '# Agent\n' }];
  const result = await operations.execute(actions, {
    confirmed: true,
    internalAutoApprove: true,
    source: 'ai-chat',
  });
  assert.equal(result.completed, 1);
  assert.ok(fs.existsSync(path.join(vaultDir, 'agent.md')));
});

test('archive moves an Inbox note and removes its Inbox marker', async () => {
  const source = path.join(vaultDir, 'Inbox', 'capture.md');
  const target = path.join(vaultDir, 'Project', 'capture.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, [
    '---',
    'id: 11111111-1111-4111-8111-111111111111',
    'title: capture',
    'pinned: false',
    'created_at: 2026-10-01T00:00:00.000Z',
    'updated_at: 2026-10-01T00:00:00.000Z',
    'status: captured',
    'type: inbox',
    '---',
    '',
    '# Capture',
  ].join('\n'), 'utf8');
  const actions = [{ type: 'archive', path: 'Inbox/capture.md', targetPath: 'Project/capture.md' }];
  const preview = operations.preview(actions);
  const result = await operations.execute(actions, { confirmed: true, planHash: preview.planHash, source: 'api' });

  assert.equal(result.completed, 1);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(target), true);
  const archived = fs.readFileSync(target, 'utf8');
  assert.match(archived, /^status: processed$/m);
  assert.doesNotMatch(archived, /^type: inbox$/m);
  assert.match(archived, /# Capture/);
});
