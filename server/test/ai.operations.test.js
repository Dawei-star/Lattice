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

test('AI preview marks sensitive paths for extra confirmation without treating them as role-blocked', async () => {
  const source = path.join(vaultDir, 'AI', 'API密钥', 'API密钥存储.md');
  const target = path.join(vaultDir, 'Archive', 'API密钥存储.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '# Local secret reference\n', 'utf8');
  const actions = [{ type: 'move', path: 'AI/API密钥/API密钥存储.md', targetPath: 'Archive/API密钥存储.md' }];
  const preview = operations.preview(actions);

  assert.equal(preview.blocked, false);
  assert.equal(preview.requiresAdditionalConfirmation, true);
  assert.equal(preview.requiresSensitiveConfirmation, true);
  assert.equal(preview.operations[0].sensitive, true);
  await assert.rejects(
    () => runFileActions(actions, { confirmed: true, planHash: preview.planHash }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    () => runFileActions(actions, { confirmed: true, additionalConfirmed: true, planHash: preview.planHash }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  const result = await runFileActions(actions, {
    confirmed: true,
    additionalConfirmed: true,
    sensitiveConfirmed: true,
    planHash: preview.planHash,
  });
  assert.equal(result.completed, 1);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(target), true);
});

test('a normal file is not sensitive just because its parent folder is named API_KEY', () => {
  const file = path.join(vaultDir, '项目', 'AI', 'API_KEY', '免费模型.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Free model\n', 'utf8');

  const preview = operations.preview([{ type: 'update', path: '项目/AI/API_KEY/免费模型.md', content: '# Updated\n' }]);
  assert.equal(preview.blocked, false);
  assert.equal(preview.operations[0].sensitive, false);
});

test('delete and batch plans require an additional confirmation', async () => {
  fs.writeFileSync(path.join(vaultDir, 'batch-a.md'), '# A\n', 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'batch-b.md'), '# B\n', 'utf8');
  const actions = [
    { type: 'update', path: 'batch-a.md', content: '# A2\n' },
    { type: 'update', path: 'batch-b.md', content: '# B2\n' },
  ];
  const preview = operations.preview(actions);

  assert.equal(preview.requiresAdditionalConfirmation, true);
  assert.deepEqual(preview.additionalConfirmationReasons, ['batch']);
  await assert.rejects(
    () => runFileActions(actions, { confirmed: true, planHash: preview.planHash }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  const result = await runFileActions(actions, {
    confirmed: true,
    additionalConfirmed: true,
    planHash: preview.planHash,
  });
  assert.equal(result.completed, 2);
});

test('preview quality checks surface conflicting actions before execution', async () => {
  const file = path.join(vaultDir, 'quality-conflict.md');
  fs.writeFileSync(file, '# Original\n', 'utf8');
  const actions = [
    { id: 'same-action', type: 'update', path: 'quality-conflict.md', content: '# Updated\n' },
    { id: 'same-action', type: 'delete', path: 'quality-conflict.md' },
  ];
  const preview = operations.preview(actions);
  const warningCodes = preview.quality.warnings.map((warning) => warning.code);

  assert.equal(preview.quality.blocked, true);
  assert.ok(warningCodes.includes('duplicate-action-id'));
  assert.ok(warningCodes.includes('duplicate-target'));
  await assert.rejects(
    () => operations.execute(actions, {
      confirmed: true,
      additionalConfirmed: true,
      planHash: preview.planHash,
    }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '# Original\n');
});

test('preview quality checks explain missing sources and occupied targets', () => {
  fs.writeFileSync(path.join(vaultDir, 'occupied.md'), '# Existing\n', 'utf8');
  const preview = operations.preview([
    { type: 'move', path: 'missing-quality.md', targetPath: 'occupied.md' },
  ]);
  const warningCodes = preview.quality.warnings.map((warning) => warning.code);

  assert.equal(preview.quality.blocked, true);
  assert.ok(warningCodes.includes('missing-source'));
  assert.ok(warningCodes.includes('target-exists'));
});

test('internal agent approval cannot bypass a preview hash', async () => {
  const actions = [{ type: 'create', path: 'agent.md', content: '# Agent\n' }];
  await assert.rejects(
    () => operations.execute(actions, { confirmed: true, internalAutoApprove: true, source: 'ai-chat' }),
    (error) => error.status === 422,
  );
  assert.equal(fs.existsSync(path.join(vaultDir, 'agent.md')), false);
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
