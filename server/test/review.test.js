import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-review-'));
const vaultDir = path.join(root, 'vault');
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(root, 'lattice.db');
process.env.VAULT_DIR = vaultDir;

const [{ createApp }, { openDatabase, closeDatabase, getDb }, { runMigrations }, notes, folders] = await Promise.all([
  import('../src/app.js'),
  import('../src/db/index.js'),
  import('../src/db/migrate.js'),
  import('../src/modules/notes/notes.service.js'),
  import('../src/modules/folders/folders.service.js'),
]);

openDatabase();
runMigrations();

test('knowledge health scan reports actionable vault findings', async (t) => {
  const project = folders.create({ name: '项目' });
  const archive = folders.create({ name: '归档' });

  const inbox = notes.create({
    title: '待整理想法',
    content: '把这个想法归入项目。',
    properties: { type: 'inbox', status: 'captured' },
  });
  const isolated = notes.create({ title: '孤立笔记', content: '这篇笔记没有任何双链。', folderId: project.id });
  const source = notes.create({ title: '项目入口', content: '参考 [[尚未创建的概念]]。', folderId: project.id, properties: { status: 'active' } });
  const old = notes.create({ title: '长期未更新', content: '一段很久没有维护的内容。', folderId: project.id, properties: { status: 'active' } });
  const duplicateA = notes.create({ title: '重复方案', content: '这是同一份方案正文，应该被巡检识别。', folderId: project.id, properties: { status: 'active' } });
  const duplicateB = notes.create({ title: '重复方案', content: '这是同一份方案正文，应该被巡检识别。', folderId: archive.id, properties: { status: 'active' } });
  const incomplete = notes.create({ title: '未整理笔记', content: '没有目录、标签和自定义属性。' });
  getDb().prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run('2025-01-01T00:00:00.000Z', old.id);

  const server = createApp().listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/review/health?staleDays=90`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.noteCount, 7);
  const inboxFinding = payload.data.categories.inbox.find((item) => item.id === inbox.id);
  assert.equal(Boolean(inboxFinding), true);
  assert.equal(inboxFinding.status, 'open');
  assert.equal(inboxFinding.severity, 'error');
  assert.equal(inboxFinding.confidence, 'high');
  const isolatedFinding = payload.data.categories.isolated.find((item) => item.id === isolated.id);
  assert.equal(Boolean(isolatedFinding), true);
  assert.equal(isolatedFinding.status, 'open');
  assert.equal(isolatedFinding.severity, 'candidate');
  assert.equal(isolatedFinding.confidence, 'review');
  const brokenLinkFinding = payload.data.categories.brokenLinks[0];
  assert.equal(brokenLinkFinding.targetTitle, '尚未创建的概念');
  assert.equal(brokenLinkFinding.sources[0].id, source.id);
  assert.equal(brokenLinkFinding.status, 'open');
  assert.equal(brokenLinkFinding.severity, 'error');
  assert.equal(brokenLinkFinding.confidence, 'high');
  assert.equal(payload.data.categories.stale.some((item) => item.id === old.id), true);
  assert.equal(payload.data.categories.incomplete.some((item) => item.id === incomplete.id), true);
  const duplicateFinding = payload.data.categories.duplicates.find((item) => item.noteIds.includes(duplicateA.id) && item.noteIds.includes(duplicateB.id));
  assert.equal(Boolean(duplicateFinding), true);
  assert.equal(duplicateFinding.status, 'open');
  assert.equal(duplicateFinding.severity, 'warning');
  assert.equal(duplicateFinding.confidence, 'high');
  assert.equal(payload.data.summary.total > 0, true);
  assert.equal(payload.data.summary.hardTotal >= 2, true);
  assert.equal(payload.data.summary.candidateTotal > 0, true);
  assert.match(payload.data.scannedAt, /^\d{4}-\d{2}-\d{2}T/);

  const planResponse = await fetch(`http://127.0.0.1:${port}/api/review/health/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findingIds: [duplicateFinding.id] }),
  });
  const planPayload = await planResponse.json();
  assert.equal(planResponse.status, 200);
  assert.equal(planPayload.data.summary.deletes, 1);
  assert.equal(planPayload.data.confirmation.secondConfirmationRequired, true);
  assert.equal(planPayload.data.manual.length, 0);

  const unconfirmedRepair = await fetch(`http://127.0.0.1:${port}/api/review/health/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: planPayload.data.id, planHash: planPayload.data.planHash }),
  });
  assert.equal(unconfirmedRepair.status, 422);

  const firstConfirmationOnly = await fetch(`http://127.0.0.1:${port}/api/review/health/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: planPayload.data.id, planHash: planPayload.data.planHash, confirmed: true }),
  });
  assert.equal(firstConfirmationOnly.status, 422);

  const executeRepair = await fetch(`http://127.0.0.1:${port}/api/review/health/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      planId: planPayload.data.id,
      planHash: planPayload.data.planHash,
      confirmed: true,
      secondConfirmed: true,
    }),
  });
  const executePayload = await executeRepair.json();
  assert.equal(executeRepair.status, 200);
  assert.equal(executePayload.data.completed, 1, JSON.stringify(executePayload.data));
  const remainingDuplicateIds = [duplicateA.id, duplicateB.id].filter((id) => {
    try {
      notes.getDetail(id);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(remainingDuplicateIds.length, 1);
});
