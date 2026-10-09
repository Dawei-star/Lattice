import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-vault-profile-'));
const vaultDir = path.join(root, 'vault');
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(root, 'lattice.db');
process.env.VAULT_DIR = vaultDir;

const [{ createApp }, { openDatabase, closeDatabase }, { runMigrations }, profile, templates, digest] = await Promise.all([
  import('../src/app.js'),
  import('../src/db/index.js'),
  import('../src/db/migrate.js'),
  import('../src/vault/profile.js'),
  import('../src/modules/notes/notes.templates.js'),
  import('../src/modules/ai/ai.digest.js'),
]);

openDatabase();
runMigrations();

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test('vault profile defaults, hot reloads, validates, and drives system folders', async () => {
  const initial = profile.loadVaultProfile(vaultDir);
  assert.equal(initial.status, 'default');
  assert.deepEqual(initial.profile.paths, { inbox: 'Inbox', daily: 'Daily', journal: 'Journal' });

  fs.mkdirSync(path.dirname(initial.filePath), { recursive: true });
  fs.writeFileSync(initial.filePath, JSON.stringify({
    version: 1,
    paths: { inbox: 'Capture', daily: 'Work/Daily', journal: 'Work/Journal' },
  }), 'utf8');

  const loaded = profile.loadVaultProfile(vaultDir);
  assert.equal(loaded.status, 'loaded');
  assert.deepEqual(loaded.profile.paths, { inbox: 'Capture', daily: 'Work/Daily', journal: 'Work/Journal' });

  const daily = await templates.createDaily({ date: '2030-01-02' });
  assert.equal(daily.filePath, 'Work/Daily/2030-01-02.md');
  assert.equal(fs.existsSync(path.join(vaultDir, daily.filePath)), true);

  const generated = await digest.generateDigest({ date: new Date('2030-01-02T12:00:00.000Z') });
  assert.equal(generated.filePath, `Work/Journal/${digest.digestTitleFor(new Date('2030-01-02T12:00:00.000Z'))}.md`);
  assert.equal(fs.existsSync(path.join(vaultDir, generated.filePath)), true);

  const infoResponse = await fetch(`${baseUrl}/api/vault/info`);
  const info = await infoResponse.json();
  assert.equal(infoResponse.status, 200);
  assert.equal(info.data.profileStatus, 'loaded');
  assert.deepEqual(info.data.profile.paths, loaded.profile.paths);

  const updateResponse = await fetch(`${baseUrl}/api/vault/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      paths: { inbox: 'Capture/New', daily: 'Work/Daily Notes', journal: 'Work/Journal' },
      confirmed: true,
    }),
  });
  const updated = await updateResponse.json();
  assert.equal(updateResponse.status, 200);
  assert.equal(updated.data.profileStatus, 'loaded');
  assert.deepEqual(updated.data.profile.paths, {
    inbox: 'Capture/New',
    daily: 'Work/Daily Notes',
    journal: 'Work/Journal',
  });
  assert.deepEqual(profile.loadVaultProfile(vaultDir).profile.paths, updated.data.profile.paths);

  const invalidUpdateResponse = await fetch(`${baseUrl}/api/vault/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      paths: { inbox: '../escape', daily: 'Daily', journal: 'Journal' },
      confirmed: true,
    }),
  });
  const invalidUpdate = await invalidUpdateResponse.json();
  assert.equal(invalidUpdateResponse.status, 422);
  assert.equal(invalidUpdate.error.code, 'VALIDATION_ERROR');

  fs.writeFileSync(initial.filePath, '{"version": 2}', 'utf8');
  const invalid = profile.loadVaultProfile(vaultDir);
  assert.equal(invalid.status, 'invalid');
  assert.match(invalid.warning, /Invalid profile/);
  assert.deepEqual(invalid.profile.paths, { inbox: 'Inbox', daily: 'Daily', journal: 'Journal' });

  const invalidInfoResponse = await fetch(`${baseUrl}/api/vault/info`);
  const invalidInfo = await invalidInfoResponse.json();
  assert.equal(invalidInfo.data.profileStatus, 'invalid');
  assert.deepEqual(invalidInfo.data.profile.paths, { inbox: 'Inbox', daily: 'Daily', journal: 'Journal' });
});
