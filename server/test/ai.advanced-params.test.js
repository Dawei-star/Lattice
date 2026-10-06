import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-advparam-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';

const { openDatabase } = await import('../src/db/index.js');
const { runMigrations } = await import('../src/db/migrate.js');
openDatabase();
runMigrations();

const settings = await import('../src/modules/ai/ai.settings.js');
const { warmupMcpConnections } = await import('../src/modules/ai/ai.mcp.js');

test('provider advanced params survive settings round-trip and clamp out-of-range values', () => {
  settings.saveServerSettings({
    providers: [
      { id: 'p1', name: '带参数', endpoint: 'https://api.example.com/v1/chat/completions', model: 'm1', apiKey: 'k'.repeat(20), temperature: 1.7, maxTokens: 4096, contextWindowTokens: 1_000_000 },
      { id: 'p2', name: '越界收缩', endpoint: 'https://api.example.com/v1/chat/completions', model: 'm2', apiKey: 'k'.repeat(20), temperature: 9, maxTokens: -5 },
      { id: 'p3', name: '无参数', endpoint: 'https://api.example.com/v1/chat/completions', model: 'm3', apiKey: 'k'.repeat(20) },
    ],
    activeProviderId: 'p1',
    embedding: null,
  });

  const loaded = settings.loadServerSettings();
  const p1 = loaded.providers.find((provider) => provider.id === 'p1');
  assert.equal(p1.temperature, 1.7);
  assert.equal(p1.maxTokens, 4096);
  assert.equal(p1.contextWindowTokens, 1_000_000);

  // 越界值被收拢：temperature >2 收到 2；非法 maxTokens 直接不下发
  const p2 = loaded.providers.find((provider) => provider.id === 'p2');
  assert.equal(p2.temperature, 2);
  assert.equal(p2.maxTokens, undefined);

  // 未配置的 provider 不带这两个键，服务端回落内置默认
  const p3 = loaded.providers.find((provider) => provider.id === 'p3');
  assert.equal(p3.temperature, undefined);
  assert.equal(p3.maxTokens, undefined);

  // resolveChatProvider 透传高级参数
  const resolved = settings.resolveChatProvider(null);
  assert.equal(resolved.id, 'p1');
  assert.equal(resolved.temperature, 1.7);
  assert.equal(resolved.maxTokens, 4096);
});

test('warmupMcpConnections with no servers resolves to empty status', async () => {
  const status = await warmupMcpConnections([]);
  assert.deepEqual(status, []);
});
