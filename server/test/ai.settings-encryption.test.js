import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-ai-settings-encryption-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(root, 'lattice.db');
process.env.AI_SETTINGS_ENCRYPTION_KEY = 'ab'.repeat(32);

const [{ openDatabase, closeDatabase, getDb }, { runMigrations }, settings] = await Promise.all([
  import('../src/db/index.js'),
  import('../src/db/migrate.js'),
  import('../src/modules/ai/ai.settings.js'),
]);

openDatabase();
runMigrations();

test.after(async () => {
  closeDatabase();
  await fs.rm(root, { recursive: true, force: true });
});

test('AI settings are encrypted at rest and remain readable through the service API', () => {
  const expected = {
    providers: [{ id: 'encrypted-provider', endpoint: 'https://example.com/v1', model: 'test', apiKey: 'secret-api-key' }],
    activeProviderId: 'encrypted-provider',
    embedding: null,
  };

  settings.saveServerSettings(expected);
  const stored = getDb().prepare("SELECT value FROM ai_settings WHERE key = 'model-config'").get();
  assert.match(stored.value, /^enc:v1:/);
  assert.doesNotMatch(stored.value, /secret-api-key/);
  assert.equal(settings.loadServerSettings().providers[0].apiKey, 'secret-api-key');
});

test('legacy plaintext settings remain readable for migration compatibility', () => {
  getDb().prepare(
    "UPDATE ai_settings SET value = ?, updated_at = datetime('now') WHERE key = 'model-config'",
  ).run(JSON.stringify({
    providers: [{ id: 'legacy-provider', endpoint: 'https://legacy.example/v1', model: 'legacy', apiKey: 'legacy-key' }],
    activeProviderId: 'legacy-provider',
    embedding: null,
  }));

  assert.equal(settings.loadServerSettings().providers[0].apiKey, 'legacy-key');
});
