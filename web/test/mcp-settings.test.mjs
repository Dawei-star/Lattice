import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_WRITE_TOOL_NAMES,
  collectActiveMcpServers,
  createMcpServer,
  loadMcpSettings,
  mergeProjectServers,
  pendingArgTokens,
  readEnvValue,
  resolveServerArgs,
  saveMcpSettings,
  serversToProjectDocument,
  setArgValue,
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

test('required args survive a save/load round trip, de-duplicated and trimmed', () => {
  const server = createMcpServer({
    id: 'mcp-market-git',
    key: 'git',
    args: ['mcp-server-git', '--repository', '{repository}'],
    requiresArgs: [
      { token: 'repository', label: 'Git 仓库路径', hint: '要交给 Agent 查看的仓库目录', preset: 'vaultDir' },
      { token: 'repository', label: '重复项' },
      { token: '   ' },
      { token: 'other', label: '别的参数', preset: 'nonsense' },
    ],
    argValues: { repository: '  D:/repo  ', empty: '   ' },
  });
  assert.deepEqual(server.requiresArgs, [
    { token: 'repository', label: 'Git 仓库路径', hint: '要交给 Agent 查看的仓库目录', preset: 'vaultDir' },
    { token: 'other', label: '别的参数', hint: '', preset: '' },
  ]);
  assert.deepEqual(server.argValues, { repository: 'D:/repo' });

  const saved = saveMcpSettings({ projectEnabled: false, servers: [server] });
  values.set('lattice-mcp-settings-v1', JSON.stringify(saved));
  const loaded = loadMcpSettings();
  assert.deepEqual(loaded.servers[0].requiresArgs, server.requiresArgs);
  assert.deepEqual(loaded.servers[0].argValues, { repository: 'D:/repo' });
  assert.deepEqual(createMcpServer({ id: 'x', key: 'x' }).argValues, {});
});

test('arg templates materialize only when a value was filled in', () => {
  const args = ['mcp-server-git', '--repository', '{repository}', '--verbose'];
  assert.deepEqual(pendingArgTokens(args), ['repository']);
  assert.deepEqual(pendingArgTokens(['a', 'b']), []);

  // 没填：保留占位符，绝不退化成相对路径
  assert.deepEqual(resolveServerArgs(args, {}), args);
  assert.deepEqual(resolveServerArgs(args, { repository: '   ' }), args);
  // 填了：替换成实际值，并去掉首尾空白
  assert.deepEqual(resolveServerArgs(args, { repository: '  D:/repo  ' }), ['mcp-server-git', '--repository', 'D:/repo', '--verbose']);
  // 只替换「整段即占位符」的参数
  assert.deepEqual(resolveServerArgs(['--path={repository}'], { repository: 'D:/repo' }), ['--path={repository}']);
  assert.deepEqual(resolveServerArgs(undefined, { a: 'b' }), []);
});

test('setArgValue writes one token and drops empty values', () => {
  assert.deepEqual(setArgValue({}, 'repository', 'D:/repo'), { repository: 'D:/repo' });
  assert.deepEqual(setArgValue({ repository: 'old' }, 'repository', ' new '), { repository: 'new' });
  assert.deepEqual(setArgValue({ repository: 'old' }, 'repository', '   '), {});
  assert.deepEqual(setArgValue({ repository: 'old' }, 'repository', ''), {});
  // 不修改入参
  const original = { repository: 'old' };
  setArgValue(original, 'repository', 'new');
  assert.deepEqual(original, { repository: 'old' });
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

test('collectActiveMcpServers picks complete enabled entries for the AI chat request', () => {
  const ready = createMcpServer({
    id: 'mcp-market-git', key: 'git', name: 'Git',
    command: 'uvx', args: ['mcp-server-git', '--repository', '{repository}'],
    argValues: { repository: 'D:/repo' }, enabled: true,
  });
  const pendingTemplate = createMcpServer({
    id: 'mcp-market-sqlite', key: 'sqlite', name: 'SQLite',
    command: 'uvx', args: ['mcp-server-sqlite', '--db-path', '{dbFile}'],
  });
  const disabled = createMcpServer({ id: 'mcp-market-fetch', key: 'fetch', name: 'Fetch', command: 'uvx', args: ['mcp-server-fetch'], enabled: false });
  const builtin = createMcpServer({ id: 'lattice-local', key: 'lattice', name: 'Lattice', command: 'node', args: ['server.mjs'], builtin: true });
  const sse = createMcpServer({ id: 'mcp-remote', key: 'remote', name: 'Remote', transport: 'sse', url: 'https://example.com/mcp' });
  const badSse = createMcpServer({ id: 'mcp-remote-bad', key: 'remote-bad', name: 'Bad', transport: 'sse', url: '尚未填写' });
  // 原始对象绕过 createMcpServer 的默认值（空命令会被它兜底成 'node'）：
  // collectActiveMcpServers 必须自己把这种残缺条目挡在门外
  const noCommand = { id: 'mcp-empty', key: 'empty', name: 'Empty', command: '', args: [], env: {}, enabled: true };

  const picked = collectActiveMcpServers({
    projectEnabled: false,
    servers: [ready, pendingTemplate, disabled, builtin, sse, badSse, noCommand],
  });
  assert.deepEqual(picked.map((server) => server.key), ['git', 'remote']);
  assert.deepEqual(picked[0], {
    key: 'git', name: 'Git', transport: 'stdio',
    command: 'uvx', args: ['mcp-server-git', '--repository', 'D:/repo'], env: {},
  });
  assert.deepEqual(picked[1], { key: 'remote', name: 'Remote', transport: 'sse', url: 'https://example.com/mcp', env: {} });

  // 空配置：安全地返回空数组（省略 settings 时才走 localStorage，本文件其他用例已有覆盖）
  assert.deepEqual(collectActiveMcpServers({}), []);
  assert.deepEqual(collectActiveMcpServers({ projectEnabled: false, servers: [] }), []);
});

test('mergeProjectServers lets user-level win on key collision and drops disabled entries', () => {
  const user = [
    { key: 'git', name: 'Git(用户级)', transport: 'stdio', command: 'uvx', args: ['a'], env: {} },
    { key: 'fetch', name: 'Fetch', transport: 'stdio', command: 'uvx', args: ['b'], env: {} },
  ];
  const project = [
    { key: 'git', name: 'Git(项目级)', transport: 'stdio', command: 'uvx', args: ['c'], env: {} },
    { key: 'docs', name: 'Docs', transport: 'sse', url: 'https://x/mcp', env: {} },
    { key: 'off', name: 'Off', transport: 'stdio', command: 'node', args: [], enabled: false },
    { key: 'lattice', name: 'Lattice', transport: 'stdio', command: 'node', builtin: true },
  ];
  const merged = mergeProjectServers(user, project);
  assert.deepEqual(merged.map((server) => server.key), ['git', 'fetch', 'docs']);
  assert.equal(merged[0].name, 'Git(用户级)');

  // 界面专用字段被裁掉，只留连接所需最小集
  assert.deepEqual(Object.keys(merged[1]).sort(), ['args', 'command', 'env', 'key', 'name', 'transport']);
  assert.deepEqual(Object.keys(merged[2]).sort(), ['env', 'key', 'name', 'transport', 'url']);

  assert.deepEqual(mergeProjectServers(null, project).map((server) => server.key), ['git', 'docs']);
  assert.equal(mergeProjectServers(null, project)[0].name, 'Git(项目级)');
  assert.deepEqual(mergeProjectServers(user, null).map((server) => server.key), ['git', 'fetch']);
  assert.equal(mergeProjectServers(user, project).length <= 8, true);
});

test('serversToProjectDocument round-trips internal servers into the disk shape', () => {
  const document = serversToProjectDocument([
    { key: 'git', name: 'Git', description: '仓库', transport: 'stdio', command: 'uvx', args: ['mcp-server-git'], env: { A: '1' }, enabled: true },
    { key: 'docs', name: 'Docs', transport: 'sse', url: 'https://x/mcp', env: {}, enabled: false },
    { key: 'broken' },
  ]);
  assert.deepEqual(Object.keys(document.mcpServers), ['git', 'docs']);
  assert.deepEqual(document.mcpServers.git, {
    name: 'Git', description: '仓库', transport: 'stdio', command: 'uvx', args: ['mcp-server-git'], env: { A: '1' }, enabled: true,
  });
  assert.equal(document.mcpServers.docs.url, 'https://x/mcp');
  assert.equal('command' in document.mcpServers.docs, false);
  assert.equal(serversToProjectDocument(null).mcpServers && Object.keys(serversToProjectDocument(null).mcpServers).length, 0);
});
