import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-notes-p1-'));
const vaultDir = path.join(root, 'vault');
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(root, 'lattice.db');
process.env.VAULT_DIR = vaultDir;

const [{ createApp }, { openDatabase, closeDatabase }, { runMigrations }, { VaultAdapter }, { applyVaultChange }] = await Promise.all([
  import('../src/app.js'),
  import('../src/db/index.js'),
  import('../src/db/migrate.js'),
  import('../src/vault/vault.adapter.js'),
  import('../src/vault/sync.js'),
]);

openDatabase();
runMigrations();

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function request(method, pathname, body) {
  const requestBody = body === undefined || method === 'GET' ? body : { confirmed: true, ...body };
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: requestBody === undefined ? undefined : { 'content-type': 'application/json' },
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
  });
  return { response, payload: await response.json() };
}

async function requestWithoutConfirmation(method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  // applyVaultChange schedules debounced semantic indexing; let it drain before
  // closing the temporary database used by this integration test.
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  closeDatabase();
  await fs.rm(root, { recursive: true, force: true });
});

test('note history snapshots preserve raw markdown and protect restores from stale writes', async () => {
  const created = await request('POST', '/api/notes', { title: 'History', content: '# First\n\nraw  *markdown*' });
  assert.equal(created.response.status, 201);
  const noteId = created.payload.data.id;

  const updated = await requestWithoutConfirmation('PATCH', `/api/notes/${noteId}`, {
    content: '# Second\n\nchanged',
    expectedHash: created.payload.data.contentHash,
  });
  assert.equal(updated.response.status, 200);

  const unconfirmedRename = await requestWithoutConfirmation('PATCH', `/api/notes/${noteId}`, {
    title: 'History renamed',
    expectedHash: updated.payload.data.contentHash,
  });
  assert.equal(unconfirmedRename.response.status, 422);

  const history = await request('GET', `/api/notes/${noteId}/history`);
  assert.equal(history.response.status, 200);
  assert.equal(history.payload.data.items.length, 1);
  assert.equal(history.payload.data.items[0].size > 0, true);

  const version = history.payload.data.items[0].version;
  const snapshot = await request('GET', `/api/notes/${noteId}/history/${version}`);
  assert.equal(snapshot.response.status, 200);
  assert.equal(snapshot.payload.data.content, '# First\n\nraw  *markdown*');

  const adapter = new VaultAdapter(vaultDir);
  await adapter.write({
    ...updated.payload.data,
    content: '# External change',
  });
  await applyVaultChange(adapter, updated.payload.data.filePath);
  const externalHistory = await request('GET', `/api/notes/${noteId}/history`);
  assert.equal(externalHistory.payload.data.items.length, 2);

  const staleHash = externalHistory.payload.data.currentHash;
  await request('PATCH', `/api/notes/${noteId}`, { content: '# Third' });
  const staleRestore = await request('POST', `/api/notes/${noteId}/history/${version}/restore`, {
    expectedCurrentHash: staleHash,
  });
  assert.equal(staleRestore.response.status, 409);

  const latestHistory = await request('GET', `/api/notes/${noteId}/history`);
  const restored = await request('POST', `/api/notes/${noteId}/history/${version}/restore`, {
    expectedCurrentHash: latestHistory.payload.data.currentHash,
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.payload.data.content, '# First\n\nraw  *markdown*');

  const afterRestore = await request('GET', `/api/notes/${noteId}/history`);
  assert.equal(afterRestore.payload.data.items.length, 4);
});

test('templates and daily notes are isolated from the note projection and daily creation is idempotent', async () => {
  await fs.mkdir(path.join(vaultDir, '_templates'), { recursive: true });
  const builtinTemplates = await request('GET', '/api/notes/templates');
  assert.equal(builtinTemplates.response.status, 200);
  assert.deepEqual(
    builtinTemplates.payload.data.map((item) => item.name),
    ['bug', 'decision', 'learning', 'meeting', 'retrospective'],
  );

  await fs.writeFile(
    path.join(vaultDir, '_templates', 'meeting.md'),
    '---\nstatus: planned\npriority: 2\n---\n# {{title}}\n\nDate: {{date}}\n\nTime: {{time}}',
    'utf8',
  );

  const templates = await request('GET', '/api/notes/templates');
  assert.equal(templates.response.status, 200);
  assert.deepEqual(
    templates.payload.data.map((item) => item.name),
    ['bug', 'decision', 'learning', 'meeting', 'retrospective'],
  );

  const generated = await request('POST', '/api/notes/from-template', {
    template: 'meeting',
    title: 'Planning',
    date: '2026-09-29',
  });
  assert.equal(generated.response.status, 201);
  assert.match(generated.payload.data.content, /Planning/);
  assert.match(generated.payload.data.content, /2026-09-29/);
  assert.deepEqual(generated.payload.data.properties, { priority: 2, status: 'planned' });
  assert.equal(generated.payload.data.filePath, 'Planning.md');

  const firstDaily = await request('POST', '/api/notes/daily', { date: '2026-09-29' });
  const secondDaily = await request('POST', '/api/notes/daily', { date: '2026-09-29' });
  assert.equal(firstDaily.response.status, 201);
  assert.equal(secondDaily.response.status, 201);
  assert.equal(firstDaily.payload.data.id, secondDaily.payload.data.id);
  assert.equal(firstDaily.payload.data.filePath, 'Daily/2026-09-29.md');
  assert.equal(secondDaily.payload.data.filePath, 'Daily/2026-09-29.md');

  const noteIndex = await request('GET', '/api/notes/index');
  assert.equal(noteIndex.payload.data.some((note) => note.filePath.startsWith('_templates/')), false);
});

test('note properties are stored in frontmatter, exposed by detail and restored with history', async () => {
  const created = await request('POST', '/api/notes', {
    title: 'Properties',
    content: 'body',
    properties: { status: 'draft', priority: 1, tags: ['ai', 'notes'] },
  });
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.payload.data.properties, { priority: 1, status: 'draft', tags: ['ai', 'notes'] });

  const updated = await request('PATCH', `/api/notes/${created.payload.data.id}`, {
    properties: { status: 'published', owner: 'team' },
  });
  assert.equal(updated.response.status, 200);
  assert.deepEqual(updated.payload.data.properties, { owner: 'team', status: 'published' });

  const raw = await fs.readFile(path.join(vaultDir, updated.payload.data.filePath), 'utf8');
  assert.match(raw, /^owner: team$/m);
  assert.match(raw, /^status: published$/m);

  const history = await request('GET', `/api/notes/${created.payload.data.id}/history`);
  const version = await request('GET', `/api/notes/${created.payload.data.id}/history/${history.payload.data.items[0].version}`);
  assert.deepEqual(version.payload.data.properties, { priority: 1, status: 'draft', tags: ['ai', 'notes'] });
});

test('history route rejects malformed version identifiers before touching the filesystem', async () => {
  const created = await request('POST', '/api/notes', { title: 'Validation', content: 'body' });
  const result = await request('GET', `/api/notes/${created.payload.data.id}/history/not-a-version`);
  assert.equal(result.response.status, 422);
  assert.equal(result.payload.error.code, 'VALIDATION_ERROR');
});

test('Inbox list filters expose frontmatter status and preserve normal note pagination', async () => {
  const captured = await request('POST', '/api/notes', {
    title: 'Inbox captured',
    content: 'capture me',
    properties: { type: 'inbox', status: 'captured' },
  });
  const processed = await request('POST', '/api/notes', {
    title: 'Inbox processed',
    content: 'done',
    properties: { type: 'inbox', status: 'processed' },
  });
  const normal = await request('POST', '/api/notes', {
    title: 'Project note',
    content: 'project',
    properties: { status: 'processed' },
  });
  assert.equal(captured.response.status, 201);
  assert.equal(processed.response.status, 201);
  assert.equal(normal.response.status, 201);

  const inbox = await request('GET', '/api/notes?inboxStatus=all&limit=20&offset=0');
  assert.equal(inbox.response.status, 200);
  assert.equal(inbox.payload.meta.total, 2);
  assert.deepEqual(inbox.payload.data.map((note) => note.properties.type), ['inbox', 'inbox']);

  const pending = await request('GET', '/api/notes?inboxStatus=captured&limit=20&offset=0');
  assert.equal(pending.payload.meta.total, 1);
  assert.equal(pending.payload.data[0].id, captured.payload.data.id);
  assert.equal(pending.payload.data[0].properties.status, 'captured');

  const processedInbox = await request('GET', '/api/notes?inboxStatus=processed&limit=20&offset=0');
  assert.equal(processedInbox.payload.meta.total, 1);
  assert.equal(processedInbox.payload.data[0].id, processed.payload.data.id);

  const inboxSearch = await request('GET', '/api/search?q=Inbox&inboxStatus=captured&limit=20');
  assert.equal(inboxSearch.response.status, 200);
  assert.deepEqual(inboxSearch.payload.data.map((note) => note.id), [captured.payload.data.id]);

  const noteIndex = await request('GET', '/api/notes/index');
  assert.equal(noteIndex.payload.data.find((note) => note.id === captured.payload.data.id).properties.status, 'captured');

  const normalList = await request('GET', '/api/notes?limit=20&offset=0');
  assert.equal(normalList.payload.meta.total, 8);
  assert.equal(normalList.payload.data.some((note) => note.id === normal.payload.data.id), true);
});
