import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-security-boundaries-'));
const vaultDir = path.join(root, 'vault');
const workspaceToken = 'workspace-token-1234567890';

process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.DB_FILE = path.join(root, 'lattice.db');
process.env.VAULT_DIR = vaultDir;
process.env.WORKSPACE_ACCESS_TOKEN = workspaceToken;
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

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDatabase();
  await fs.rm(root, { recursive: true, force: true });
});

test('workspace token protects the full API and health remains public', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);

  const missing = await fetch(`${baseUrl}/api/notes/index`);
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, 'UNAUTHORIZED');

  const aiOnly = await fetch(`${baseUrl}/api/notes/index`, {
    headers: { Authorization: 'Bearer ai-token-1234567890' },
  });
  assert.equal(aiOnly.status, 401);

  const authorized = await fetch(`${baseUrl}/api/notes/index`, {
    headers: { 'X-Workspace-Token': workspaceToken },
  });
  assert.equal(authorized.status, 200);
});

test('AI settings writes never return the stored API key', async () => {
  const secret = 'secret-api-key-12345';
  const response = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Workspace-Token': workspaceToken,
    },
    body: JSON.stringify({
      providers: [{
        id: 'security-test-provider',
        endpoint: 'https://example.com/v1/chat/completions',
        model: 'test-model',
        apiKey: secret,
      }],
      activeProviderId: 'security-test-provider',
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.data.providers[0].apiKey, 'masked:2345');
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(secret));

  const fetched = await fetch(`${baseUrl}/api/ai/settings`, {
    headers: { 'X-Workspace-Token': workspaceToken },
  });
  assert.equal((await fetched.json()).data.providers[0].apiKey, 'masked:2345');
});

test('non-loopback configuration requires a workspace token, not only an AI token', async () => {
  const configUrl = new URL('../src/config/index.js', import.meta.url).href;
  // 用异步 execFile 而不是 spawnSync：某些受限宿主里同步创建子进程会直接 EBUSY，
  // 那样这条用例永远红，且失败信息（stdout/stderr 都是 undefined）完全指不到真正原因。
  // 断言的都是子进程的退出码与输出，异步化不改变被测行为。
  const run = (extra = {}) => new Promise((resolve) => {
    const env = { ...process.env, NODE_ENV: 'test', HOST: '0.0.0.0', DB_FILE: path.join(root, 'child.db') };
    delete env.WORKSPACE_ACCESS_TOKEN;
    delete env.AI_ACCESS_TOKEN;
    Object.assign(env, extra);
    execFile(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(configUrl)})`], {
      cwd: path.resolve('.'),
      env,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        output: `${stdout ?? ''}\n${stderr ?? ''}`,
      });
    });
  });

  const missing = await run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /WORKSPACE_ACCESS_TOKEN/);

  const aiOnly = await run({ AI_ACCESS_TOKEN: 'ai-token-1234567890' });
  assert.notEqual(aiOnly.status, 0);
  assert.match(aiOnly.output, /WORKSPACE_ACCESS_TOKEN/);

  const protectedConfig = await run({ WORKSPACE_ACCESS_TOKEN: workspaceToken });
  assert.equal(protectedConfig.status, 0, protectedConfig.output);
});
