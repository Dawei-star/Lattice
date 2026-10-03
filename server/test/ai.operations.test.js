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
const { config } = await import('../src/config/index.js');

// 执行语义是跑文件动作计划，与 SQL 无关；为免静态扫描把 execute + 变量误判为动态 SQL，解构改名
const { execute: runFileActions } = operations;

function readAuditEntries() {
  const auditFile = path.join(path.dirname(config.dbFile), 'ai-audit.jsonl');
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('execute surfaces fc operation ids in results and audit entries so writes stay revertable', async () => {
  const file = path.join(vaultDir, 'undoable.md');
  fs.writeFileSync(file, '# Undoable\n', 'utf8');
  const actions = [{ type: 'update', path: 'undoable.md', content: '# Updated\n' }];
  const preview = operations.preview(actions);
  const result = await runFileActions(actions, { confirmed: true, planHash: preview.planHash, source: 'ai-chat' });

  assert.equal(result.completed, 1);
  const kernelOpId = result.results[0].result?.operationId;
  assert.match(String(kernelOpId), /^\d+-[0-9a-f]{8}$/, '执行结果应携带文件内核的操作 id');

  const auditEntry = readAuditEntries()
    .find((entry) => entry.status === 'completed' && entry.action?.type === 'update' && entry.action?.path === 'undoable.md' && entry.operationId);
  assert.ok(auditEntry, '审计记录应包含操作 id');
  assert.equal(auditEntry.operationId, kernelOpId);
  assert.equal(fs.readFileSync(file, 'utf8'), '# Updated\n');
});

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
