import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-viewer-guards-'));
const token = 'viewer-workspace-token-1234567890';
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.DB_FILE = path.join(root, 'lattice.db');
process.env.VAULT_DIR = path.join(root, 'vault');
process.env.WORKSPACE_ACCESS_TOKEN = token;
process.env.WORKSPACE_ACCESS_ROLE = 'viewer';
delete process.env.AI_ACCESS_TOKEN;

const [{ createApp }, { openDatabase, closeDatabase }, { runMigrations }] = await Promise.all([
  import('../src/app.js'),
  import('../src/db/index.js'),
  import('../src/db/migrate.js'),
]);

openDatabase();
runMigrations();
const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const headers = { 'X-Workspace-Token': token, 'Content-Type': 'application/json' };

async function request(method, pathname, body = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDatabase();
  await fs.rm(root, { recursive: true, force: true });
});

test('viewer can read but cannot mutate workspace resources across modules', async () => {
  const read = await request('GET', '/api/notes/index');
  assert.equal(read.response.status, 200);

  const writes = [
    ['POST', '/api/notes'],
    ['POST', '/api/folders'],
    ['PUT', '/api/canvas?path=guard.canvas'],
    ['PUT', '/api/mcp/project'],
    ['POST', '/api/review/health/execute'],
    ['PUT', '/api/vault/profile'],
    ['DELETE', '/api/tags/not-a-real-id'],
    ['POST', '/api/jobs/not-a-real-job/cancel'],
    ['POST', '/api/ai/sessions'],
    ['POST', '/api/ai/index/reindex'],
    ['POST', '/api/ai/digest'],
  ];

  for (const [method, pathname] of writes) {
    const result = await request(method, pathname);
    assert.equal(result.response.status, 403, `${method} ${pathname} must be forbidden`);
    assert.equal(result.payload.error.code, 'FORBIDDEN');
  }
});
