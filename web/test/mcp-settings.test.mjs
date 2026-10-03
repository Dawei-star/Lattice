import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_WRITE_TOOL_NAMES,
  createMcpServer,
  loadMcpSettings,
  readEnvValue,
  saveMcpSettings,
  withVisibleServers,
  writeEnvValue,
} from '../src/settings/mcpSettings.js';

const values = new Map();
globalThis.localStorage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, value); },
};

test('write tools are declared once and match the built-in server contract', () => {
  assert.ok(Object.isFrozen(MCP_WRITE_TOOL_NAMES));
  assert.deepEqual([...MCP_WRITE_TOOL_NAMES], ['create_note', 'update_note', 'restore_note_version']);
});

test('required env vars survive a save/load round trip and are de-duplicated', () => {
  const server = createMcpServer({
    id: 'mcp-market-brave-search',
    key: 'brave-search',
    requiresEnv: [
      { name: 'BRAVE_API_KEY', hint: '在 brave.com/search/api 免费申请' },
      { name: 'BRAVE_API_KEY' },
      { name: '   ' },
      'nope',
    ],
  });
  assert.deepEqual(server.requiresEnv, [{ name: 'BRAVE_API_KEY', hint: '在 brave.com/search/api 免费申请' }]);

  const saved = saveMcpSettings({ projectEnabled: false, servers: [server] });
  values.set('lattice-mcp-settings-v1', JSON.stringify(saved));
  const loaded = loadMcpSettings();
  assert.deepEqual(loaded.servers[0].requiresEnv, [{ name: 'BRAVE_API_KEY', hint: '在 brave.com/search/api 免费申请' }]);
});

test('servers without required env vars keep an empty list', () => {
  assert.deepEqual(createMcpServer({ id: 'a', key: 'a' }).requiresEnv, []);
  assert.deepEqual(createMcpServer({ id: 'b', key: 'b', requiresEnv: [] }).requiresEnv, []);
  assert.deepEqual(createMcpServer({ id: 'c', key: 'c', requiresEnv: null }).requiresEnv, []);
});

test('list mutations fall back to the visible list before settings are persisted', () => {
  const builtin = { id: 'lattice-local', key: 'lattice', enabled: true };
  const flip = (servers) => servers.map((server) => server.id === 'lattice-local' ? { ...server, enabled: !server.enabled } : server);

  // 已落盘：以已保存列表为准
  assert.deepEqual(withVisibleServers([builtin], [{ id: 'fallback' }], flip), [{ ...builtin, enabled: false }]);
  // 未落盘（info 未返回 / 读取失败）：以界面回退列表为准，否则「开关点了没反应」
  assert.deepEqual(withVisibleServers([], [builtin], flip), [{ ...builtin, enabled: false }]);
  assert.equal(withVisibleServers(undefined, [builtin], (servers) => servers.length), 1);
  assert.deepEqual(withVisibleServers([], undefined, (servers) => servers), []);
  assert.deepEqual(withVisibleServers(null, null, (servers) => servers), []);
});

test('readEnvValue only trusts string values inside a JSON object', () => {
  assert.equal(readEnvValue('{"A":"1"}', 'A'), '1');
  assert.equal(readEnvValue('{"A":1}', 'A'), '');
  assert.equal(readEnvValue('{"A":"1"}', 'B'), '');
  assert.equal(readEnvValue('[{"A":"1"}]', 'A'), '');
  assert.equal(readEnvValue('这还不是 JSON', 'A'), '');
  assert.equal(readEnvValue('', 'A'), '');
  assert.equal(readEnvValue(undefined, 'A'), '');
});

test('writeEnvValue edits one key and keeps the rest in order', () => {
  const formatted = (value) => JSON.stringify(value, null, 2);
  assert.equal(writeEnvValue('{}', 'A', 'v'), formatted({ A: 'v' }));
  assert.equal(writeEnvValue('{"A":"1","B":"2"}', 'A', '9'), formatted({ A: '9', B: '2' }));
  assert.equal(writeEnvValue('{"A":"1"}', 'B', '2'), formatted({ A: '1', B: '2' }));
  assert.equal(writeEnvValue(formatted({ A: '1' }), 'A', '2'), formatted({ A: '2' }));

  // 清空即删除该键；非法 JSON 原样返回，等用户先修好文本。
  assert.equal(writeEnvValue('{"A":"1","B":"2"}', 'A', ''), formatted({ B: '2' }));
  assert.equal(writeEnvValue('{"A":"1","B":"2"}', 'A', '   '), formatted({ B: '2' }));
  assert.equal(writeEnvValue('broken', 'A', 'v'), 'broken');
  assert.equal(writeEnvValue('[1]', 'A', 'v'), '[1]');
  assert.equal(writeEnvValue('"text"', 'A', 'v'), '"text"');
});
