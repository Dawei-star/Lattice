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
  assert.equal(payload.data.categories.inbox.some((item) => item.id === inbox.id), true);
  assert.equal(payload.data.categories.isolated.some((item) => item.id === isolated.id), true);
  assert.equal(payload.data.categories.brokenLinks[0].targetTitle, '尚未创建的概念');
  assert.equal(payload.data.categories.brokenLinks[0].sources[0].id, source.id);
  assert.equal(payload.data.categories.stale.some((item) => item.id === old.id), true);
  assert.equal(payload.data.categories.incomplete.some((item) => item.id === incomplete.id), true);
  assert.equal(payload.data.categories.duplicates.some((item) => item.noteIds.includes(duplicateA.id) && item.noteIds.includes(duplicateB.id)), true);
  assert.equal(payload.data.summary.total > 0, true);
  assert.match(payload.data.scannedAt, /^\d{4}-\d{2}-\d{2}T/);
});
