import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-attachments-p1-'));
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

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function jsonRequest(method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  closeDatabase();
  await fs.rm(root, { recursive: true, force: true });
});

test('attachment upload, reference protection, validation and orphan cleanup work against a temporary Vault', async () => {
  const created = await jsonRequest('POST', '/api/notes', { title: 'Attachment note', content: '正文' });
  assert.equal(created.response.status, 201);
  const noteId = created.payload.data.id;

  const uploadResponse = await fetch(`${baseUrl}/api/vault/attachments?name=cover.png`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: Buffer.from([137, 80, 78, 71]),
  });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201);
  assert.equal(upload.data.path, 'attachments/cover.png');

  const orphanList = await jsonRequest('GET', '/api/vault/attachments');
  assert.equal(orphanList.payload.data[0].orphan, true);

  const updated = await jsonRequest('PATCH', `/api/notes/${noteId}`, {
    content: '正文\n\n![封面](attachments/cover.png)',
  });
  assert.equal(updated.response.status, 200);

  const references = await jsonRequest('GET', '/api/vault/attachments/references?path=attachments%2Fcover.png');
  assert.equal(references.payload.data.referenced, true);
  assert.equal(references.payload.data.referencedBy[0].filePath, 'Attachment note.md');

  const blockedDelete = await jsonRequest('DELETE', '/api/vault/attachments?path=attachments%2Fcover.png');
  assert.equal(blockedDelete.response.status, 409);
  assert.equal(blockedDelete.payload.error.details.referencedBy.length, 1);

  const validation = await jsonRequest('POST', '/api/vault/attachments/validate', {
    filePath: 'Attachment note.md',
    content: '![missing](attachments/missing.png)\n![cover](attachments/cover.png)',
  });
  assert.deepEqual(validation.payload.data.missing, ['attachments/missing.png']);

  await jsonRequest('PATCH', `/api/notes/${noteId}`, { content: '正文' });
  const removed = await jsonRequest('DELETE', '/api/vault/attachments?path=attachments%2Fcover.png');
  assert.equal(removed.response.status, 200);
  assert.equal(removed.payload.data.deleted, true);

  const unusedUploadResponse = await fetch(`${baseUrl}/api/vault/attachments?name=unused.txt`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'unused',
  });
  assert.equal(unusedUploadResponse.status, 201);
  const dryRun = await jsonRequest('POST', '/api/vault/attachments/cleanup', {});
  assert.equal(dryRun.payload.data.dryRun, true);
  assert.deepEqual(dryRun.payload.data.candidates.map((item) => item.path), ['attachments/unused.txt']);

  const cleanup = await jsonRequest('POST', '/api/vault/attachments/cleanup', { dryRun: false });
  assert.deepEqual(cleanup.payload.data.deleted, ['attachments/unused.txt']);

  const invalidPath = await jsonRequest('GET', '/api/vault/attachments/references?path=..%2Fsecret.png');
  assert.equal(invalidPath.response.status, 422);
});
