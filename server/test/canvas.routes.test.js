import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-canvas-route-'));
const vaultDir = path.join(root, 'vault');
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(root, 'lattice.db');
process.env.VAULT_DIR = vaultDir;

const [{ createApp }, { openDatabase, closeDatabase }, { runMigrations }] = await Promise.all([
  import('../src/app.js'),
  import('../src/db/index.js'),
  import('../src/db/migrate.js'),
]);

openDatabase();
runMigrations();

test('GET /api/canvas/files lists nested canvas files and excludes hidden directories', async (t) => {
  await fs.mkdir(path.join(vaultDir, '项目', '原型'), { recursive: true });
  await fs.mkdir(path.join(vaultDir, '.lattice'), { recursive: true });
  await fs.writeFile(path.join(vaultDir, '项目', '原型', '流程.canvas'), '{"nodes":[],"edges":[]}');
  await fs.writeFile(path.join(vaultDir, '首页.CANVAS'), '{"nodes":[],"edges":[]}');
  await fs.writeFile(path.join(vaultDir, '.lattice', 'hidden.canvas'), '{"nodes":[],"edges":[]}');

  const server = createApp().listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    await fs.rm(root, { recursive: true, force: true });
  });

  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/canvas/files`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.data.map((file) => file.path), ['首页.CANVAS', '项目/原型/流程.canvas']);

  await fs.writeFile(path.join(vaultDir, '待改名.canvas'), '{"nodes":[],"edges":[]}');
  const renameResponse = await fetch(`http://127.0.0.1:${port}/api/canvas/file`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromPath: '待改名.canvas', toPath: '已改名' }),
  });
  const renamePayload = await renameResponse.json();
  assert.equal(renameResponse.status, 200);
  assert.equal(renamePayload.data.toPath, '已改名');
  assert.equal(await fs.stat(path.join(vaultDir, '已改名.canvas')).then(() => true), true);

  await fs.writeFile(path.join(vaultDir, '冲突源.canvas'), '{"nodes":[],"edges":[]}');
  const conflictResponse = await fetch(`http://127.0.0.1:${port}/api/canvas/file`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromPath: '冲突源.canvas', toPath: '已改名.canvas' }),
  });
  assert.equal(conflictResponse.status, 409);

  const deletablePath = path.join(vaultDir, '待删除.canvas');
  await fs.writeFile(deletablePath, '{"nodes":[],"edges":[]}');
  const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/canvas/file?path=${encodeURIComponent('待删除.canvas')}`, {
    method: 'DELETE',
  });
  const deletePayload = await deleteResponse.json();
  assert.equal(deleteResponse.status, 200);
  assert.equal(deletePayload.data.deleted, true);
  await assert.rejects(fs.stat(deletablePath));

  // 删除已设计为幂等：文件不在磁盘（外部删除、树列表过期）时同样返回 200，让前端能清掉过期条目
  const missingDeleteResponse = await fetch(`http://127.0.0.1:${port}/api/canvas/file?path=${encodeURIComponent('待删除.canvas')}`, {
    method: 'DELETE',
  });
  const missingDeletePayload = await missingDeleteResponse.json();
  assert.equal(missingDeleteResponse.status, 200);
  assert.equal(missingDeletePayload.data.deleted, true);

  const traversalDeleteResponse = await fetch(`http://127.0.0.1:${port}/api/canvas/file?path=${encodeURIComponent('../outside.canvas')}`, {
    method: 'DELETE',
  });
  assert.equal(traversalDeleteResponse.status, 422);
});
