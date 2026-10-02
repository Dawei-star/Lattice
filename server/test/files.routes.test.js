import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-files-route-'));
const vaultDir = path.join(root, 'vault');
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(root, 'lattice.db');
process.env.VAULT_DIR = vaultDir;
delete process.env.WORKSPACE_ACCESS_TOKEN;

const [{ createApp }, { openDatabase, closeDatabase }, { runMigrations }] = await Promise.all([
  import('../src/app.js'),
  import('../src/db/index.js'),
  import('../src/db/migrate.js'),
]);
const { execute: executeFileOperation } = await import('../src/modules/files/files.controller.js');

openDatabase();
runMigrations();

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const json = (route, options) => fetch(`${baseUrl}${route}`, {
  headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  ...options,
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDatabase();
  await fs.rm(root, { recursive: true, force: true });
});

test('file API previews, executes, searches and undoes a local mutation', async () => {
  await fs.mkdir(path.join(vaultDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(vaultDir, 'docs', 'note.md'), 'before\nneedle\n', 'utf8');

  const previewResponse = await json('/api/files/preview', {
    method: 'POST',
    body: JSON.stringify({ type: 'edit', path: 'docs/note.md', replace: 'before', with: 'after' }),
  });
  const previewPayload = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.match(previewPayload.data.diff, /-before/);
  assert.match(await fs.readFile(path.join(vaultDir, 'docs', 'note.md'), 'utf8'), /^before/);

  const unconfirmed = await json('/api/files/execute', {
    method: 'POST',
    body: JSON.stringify({ type: 'edit', path: 'docs/note.md', replace: 'before', with: 'after' }),
  });
  assert.equal(unconfirmed.status, 422);

  const executeResponse = await json('/api/files/execute', {
    method: 'POST',
    body: JSON.stringify({ type: 'edit', path: 'docs/note.md', replace: 'before', with: 'after', confirmed: true }),
  });
  const executePayload = await executeResponse.json();
  assert.equal(executeResponse.status, 200);
  assert.equal(executePayload.data.undoable, true);
  assert.match(await fs.readFile(path.join(vaultDir, 'docs', 'note.md'), 'utf8'), /^after/);

  const searchResponse = await json('/api/files/grep?query=needle&dir=docs&type=md');
  assert.equal(searchResponse.status, 200);
  const searchPayload = await searchResponse.json();
  assert.deepEqual(searchPayload.data.items.map((item) => ({ path: item.path, line: item.line })), [{ path: 'docs/note.md', line: 2 }]);

  const undoResponse = await json('/api/files/undo', {
    method: 'POST',
    body: JSON.stringify({ operationId: executePayload.data.operationId }),
  });
  assert.equal(undoResponse.status, 200);
  assert.match(await fs.readFile(path.join(vaultDir, 'docs', 'note.md'), 'utf8'), /^before/);

  const logResponse = await json('/api/files/log?limit=10');
  const logPayload = await logResponse.json();
  assert.equal(logResponse.status, 200);
  assert.ok(logPayload.data.some((entry) => entry.type === 'undo'));
});

test('file API rejects paths outside the Vault', async () => {
  const response = await fetch(`${baseUrl}/api/files/read?path=${encodeURIComponent('../outside.txt')}`);
  assert.equal(response.status, 422);
});

test('viewer principal cannot execute a confirmed write', () => {
  const request = {
    workspacePrincipal: { actor: 'viewer', role: 'viewer' },
    valid: { body: { type: 'delete', path: 'docs/note.md', confirmed: true } },
  };
  assert.throws(() => executeFileOperation(request, { json() {} }), /只有读取权限/);
});
