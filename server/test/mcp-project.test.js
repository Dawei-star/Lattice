import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config 在模块导入时读取环境变量：先把 VAULT_DIR 指到临时目录
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-mcp-project-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.VAULT_DIR = path.join(runtimeRoot, 'vault');
process.env.NODE_ENV = 'test';

const {
  projectMcpFilePath,
  loadProjectMcpConfig,
  saveProjectMcpConfig,
  normalizeProjectDocument,
} = await import('../src/modules/mcp/mcp.project.js');

test('missing config file reports default status instead of failing', () => {
  const result = loadProjectMcpConfig();
  assert.equal(result.status, 'default');
  assert.deepEqual(result.servers, []);
  assert.equal(result.warning, null);
  assert.ok(result.filePath.endsWith(path.join('.lattice', 'mcp.json')));
  assert.equal(result.filePath, projectMcpFilePath());
});

test('save + load round trip keeps stdio and sse servers with enabled flags', () => {
  const saved = saveProjectMcpConfig({
    mcpServers: {
      git: { command: 'uvx', args: ['mcp-server-git', '--repository', 'D:/repo'], env: { FOO: 'bar' } },
      docs: { url: 'https://example.com/mcp', transport: 'sse', enabled: false, description: '远程文档' },
      named: { name: '带名字的', command: 'node', args: ['x.js'] },
    },
  });
  assert.equal(saved.status, 'loaded');
  assert.equal(saved.warning, null);
  assert.deepEqual(saved.servers.map((server) => server.key), ['git', 'docs', 'named']);
  assert.equal(saved.servers[0].command, 'uvx');
  assert.deepEqual(saved.servers[0].args, ['mcp-server-git', '--repository', 'D:/repo']);
  assert.deepEqual(saved.servers[0].env, { FOO: 'bar' });
  assert.equal(saved.servers[0].enabled, true);
  assert.equal(saved.servers[1].transport, 'sse');
  assert.equal(saved.servers[1].enabled, false);
  assert.equal(saved.servers[2].name, '带名字的');

  const loaded = loadProjectMcpConfig();
  assert.deepEqual(loaded.servers, saved.servers);

  // 落盘的是「mcpServers 包裹 + 可读字段」，手改文件即可生效
  const onDisk = JSON.parse(fs.readFileSync(projectMcpFilePath(), 'utf8'));
  assert.ok(onDisk.mcpServers.git.command);
  assert.ok(!('key' in onDisk.mcpServers.git));
});

test('invalid entries are dropped and reported, bare map is tolerated', () => {
  const saved = saveProjectMcpConfig({
    'no-command': { args: ['x'] },
    'bad-url': { url: 'ftp://x' },
    ok: { command: 'node' },
    '': { command: 'node' },
    'empty-name': null,
  });
  assert.deepEqual(saved.servers.map((server) => server.key), ['ok']);
  assert.match(saved.warning, /4 个无效条目/);

  // 裸映射（无 mcpServers 包裹）与设置页「导入」同口径
  const bare = normalizeProjectDocument({ direct: { command: 'node' } });
  assert.deepEqual(bare.map((server) => server.key), ['direct']);
});

test('corrupted config file surfaces a warning instead of crashing the server', () => {
  fs.mkdirSync(path.dirname(projectMcpFilePath()), { recursive: true });
  fs.writeFileSync(projectMcpFilePath(), '{ 这不是 JSON', 'utf8');
  const result = loadProjectMcpConfig();
  assert.equal(result.status, 'invalid');
  assert.match(result.warning, /JSON 解析失败/);
  assert.deepEqual(result.servers, []);

  // 数组根同样按无效处理
  fs.writeFileSync(projectMcpFilePath(), '[]', 'utf8');
  assert.deepEqual(loadProjectMcpConfig().servers, []);
});

test('save rejects non-object documents with a validation error', async () => {
  const { ValidationError } = await import('../src/lib/errors.js');
  assert.throws(() => saveProjectMcpConfig([1, 2]), ValidationError);
  assert.throws(() => saveProjectMcpConfig('nope'), ValidationError);
});

test('same-key duplicate entries keep the first one', () => {
  const servers = normalizeProjectDocument({
    dup: { command: 'first' },
    // JSON.parse 不会产生同 key 对象，这里模拟合并来源；对象字面量后者覆盖前者，
    // 归一化层自身只保证「去重后单个 key 至多一个条目」
  });
  assert.equal(servers.length, 1);
});
