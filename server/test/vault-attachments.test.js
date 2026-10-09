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
  const requestBody = body === undefined || method === 'GET' ? body : { confirmed: true, ...body };
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: requestBody === undefined ? undefined : { 'content-type': 'application/json' },
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
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

  const uploadResponse = await fetch(`${baseUrl}/api/vault/attachments?name=cover.png&confirmed=true`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: Buffer.from([137, 80, 78, 71]),
  });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201);
  assert.equal(upload.data.path, 'attachments/cover.png');

  const downloadResponse = await fetch(`${baseUrl}/api/vault/download?path=${encodeURIComponent('attachments/cover.png')}`);
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get('content-disposition') ?? '', /attachment/);
  assert.equal(Buffer.from(await downloadResponse.arrayBuffer()).toString('hex'), '89504e47');

  await fs.mkdir(path.join(vaultDir, '资料'), { recursive: true });
  await fs.writeFile(path.join(vaultDir, '资料', '说明.txt'), 'downloadable file', 'utf8');
  const genericDownload = await fetch(`${baseUrl}/api/vault/download?path=${encodeURIComponent('资料/说明.txt')}`);
  assert.equal(genericDownload.status, 200);
  assert.equal(await genericDownload.text(), 'downloadable file');

  const markdownDownload = await fetch(`${baseUrl}/api/vault/download?path=${encodeURIComponent('Attachment note.md')}`);
  assert.equal(markdownDownload.status, 422);

  const hiddenDownload = await fetch(`${baseUrl}/api/vault/download?path=${encodeURIComponent('.lattice/profile.json')}`);
  assert.equal(hiddenDownload.status, 422);

  const hiddenTargetDir = path.join(vaultDir, '.hidden');
  await fs.mkdir(hiddenTargetDir, { recursive: true });
  await fs.writeFile(path.join(hiddenTargetDir, 'secret.txt'), 'hidden target', 'utf8');
  let symlinkCreated = true;
  try {
    await fs.symlink(path.join(hiddenTargetDir, 'secret.txt'), path.join(vaultDir, 'hidden-link.txt'));
  } catch (error) {
    symlinkCreated = false;
    assert.ok(['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code), `unexpected symlink error: ${error?.code}`);
  }
  if (symlinkCreated) {
    const symlinkDownload = await fetch(`${baseUrl}/api/vault/download?path=${encodeURIComponent('hidden-link.txt')}`);
    assert.equal(symlinkDownload.status, 404);
  }

  const orphanList = await jsonRequest('GET', '/api/vault/attachments');
  assert.equal(orphanList.payload.data[0].orphan, true);

  const updated = await jsonRequest('PATCH', `/api/notes/${noteId}`, {
    content: '正文\n\n![封面](attachments/cover.png)',
  });
  assert.equal(updated.response.status, 200);

  const references = await jsonRequest('GET', '/api/vault/attachments/references?path=attachments%2Fcover.png');
  assert.equal(references.payload.data.referenced, true);
  assert.equal(references.payload.data.referencedBy[0].filePath, 'Attachment note.md');

  const blockedDelete = await jsonRequest('DELETE', '/api/vault/attachments?path=attachments%2Fcover.png&confirmed=true&secondConfirmed=true');
  assert.equal(blockedDelete.response.status, 409);
  assert.equal(blockedDelete.payload.error.details.referencedBy.length, 1);

  const validation = await jsonRequest('POST', '/api/vault/attachments/validate', {
    filePath: 'Attachment note.md',
    content: '![missing](attachments/missing.png)\n![cover](attachments/cover.png)',
  });
  assert.deepEqual(validation.payload.data.missing, ['attachments/missing.png']);

  await jsonRequest('PATCH', `/api/notes/${noteId}`, { content: '正文' });
  const removed = await jsonRequest('DELETE', '/api/vault/attachments?path=attachments%2Fcover.png&confirmed=true&secondConfirmed=true');
  assert.equal(removed.response.status, 200);
  assert.equal(removed.payload.data.deleted, true);

  const unusedUploadResponse = await fetch(`${baseUrl}/api/vault/attachments?name=unused.txt&confirmed=true`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'unused',
  });
  assert.equal(unusedUploadResponse.status, 201);
  const dryRun = await jsonRequest('POST', '/api/vault/attachments/cleanup', {});
  assert.equal(dryRun.payload.data.dryRun, true);
  assert.deepEqual(dryRun.payload.data.candidates.map((item) => item.path), ['attachments/unused.txt']);

  const cleanup = await jsonRequest('POST', '/api/vault/attachments/cleanup', { dryRun: false, secondConfirmed: true });
  assert.deepEqual(cleanup.payload.data.deleted, ['attachments/unused.txt']);

  const invalidPath = await jsonRequest('GET', '/api/vault/attachments/references?path=..%2Fsecret.png');
  assert.equal(invalidPath.response.status, 422);
});
