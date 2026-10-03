import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKET_ID_PREFIX,
  MCP_MARKET_CATALOG,
  MCP_MARKET_CATEGORIES,
  MCP_MARKET_RUNTIME_HINT,
  appendMarketServer,
  createServerFromMarketEntry,
  isMarketEntryInstalled,
  resolveMarketArgs,
} from '../src/settings/mcpMarketplace.js';

const byKey = (key) => MCP_MARKET_CATALOG.find((entry) => entry.key === key);
const logoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mcp-logos');

test('every catalog entry ships a real brand logo file', () => {
  const referenced = new Set();

  for (const entry of MCP_MARKET_CATALOG) {
    assert.match(entry.logo ?? '', /^\/mcp-logos\/[a-z0-9-]+\.svg$/, `entry ${entry.key} needs a /mcp-logos/*.svg logo`);
    const file = path.join(logoDir, path.basename(entry.logo));
    assert.ok(fs.existsSync(file), `entry ${entry.key} references a missing logo file: ${entry.logo}`);

    const svg = fs.readFileSync(file, 'utf8');
    assert.match(svg, /^<svg[\s>]/, `logo ${entry.logo} is not an SVG document`);
    assert.match(svg, /viewBox="0 0 24 24"/, `logo ${entry.logo} should use the 24×24 brand viewBox`);
    assert.match(svg, /<path[\s>]/, `logo ${entry.logo} has no path data`);
    assert.match(svg, /fill="#[0-9A-Fa-f]{3,8}"/, `logo ${entry.logo} should carry a brand colour`);
    // 离线可用：不允许引用远端资源（xmlns 除外）
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), `logo ${entry.logo} must not reference remote assets`);

    referenced.add(path.basename(entry.logo));
  }

  // 目录里不留没人引用的死文件
  const onDisk = fs.readdirSync(logoDir).filter((name) => name.endsWith('.svg')).sort();
  assert.deepEqual(onDisk, [...referenced].sort(), 'mcp-logos should contain exactly the referenced logo files');
});

test('branded servers get their own logo and reference servers share the MCP mark', () => {
  const logoOf = (key) => byKey(key)?.logo;
  // MCP 官方参考实现没有独立品牌，统一用官方标识
  assert.equal(logoOf('filesystem'), logoOf('time'));
  assert.equal(logoOf('fetch'), '/mcp-logos/mcp.svg');
  // 有品牌的条目不共用同一个 logo
  const branded = ['sqlite', 'obsidian', 'brave-search', 'puppeteer', 'git', 'github'].map(logoOf);
  assert.equal(new Set(branded).size, branded.length, `branded logos must differ: ${branded.join(', ')}`);
  assert.ok(!branded.includes('/mcp-logos/mcp.svg'), 'branded servers must not fall back to the MCP mark');
});

test('market catalog entries are complete and uniquely keyed', () => {
  assert.ok(Object.isFrozen(MCP_MARKET_CATALOG), 'catalog should be immutable');
  assert.ok(MCP_MARKET_CATALOG.length >= 8, 'catalog should ship a useful number of entries');
  assert.ok(MCP_MARKET_RUNTIME_HINT.node && MCP_MARKET_RUNTIME_HINT.python, 'runtime hints feed the UI footer');

  const keys = new Set();
  for (const entry of MCP_MARKET_CATALOG) {
    assert.match(entry.key, /^[a-z0-9]+(-[a-z0-9]+)*$/, `entry key must be slug-like: ${entry.key}`);
    assert.ok(!keys.has(entry.key), `duplicate market key: ${entry.key}`);
    keys.add(entry.key);
    assert.ok(entry.name?.trim(), `entry ${entry.key} needs a display name`);
    assert.ok(entry.tagline?.trim(), `entry ${entry.key} needs a tagline`);
    assert.ok(entry.description?.trim(), `entry ${entry.key} needs a description`);
    assert.ok(['node', 'python'].includes(entry.runtime), `entry ${entry.key} has an unknown runtime`);
    assert.ok(entry.command?.trim(), `entry ${entry.key} needs a launch command`);
    assert.ok(Array.isArray(entry.args), `entry ${entry.key} args must be an array`);
    assert.match(entry.docs, /^https?:\/\//, `entry ${entry.key} needs an http(s) docs URL`);
    assert.ok(entry.tools?.length, `entry ${entry.key} should list at least one tool`);

    const names = entry.tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, `entry ${entry.key} repeats a tool name`);
    for (const tool of entry.tools) {
      assert.ok(tool.name?.trim(), `entry ${entry.key} has a tool without a name`);
      assert.ok(tool.description?.trim(), `tool ${tool.name} of ${entry.key} needs a description`);
    }
  }

  // 内置 Lattice Server 的 key 固定为 lattice；市场条目撞 key 会被误判成「已添加」。
  assert.ok(!keys.has('lattice'), 'market keys must not shadow the builtin lattice server');
});

test('every catalog category is reachable from the filter chips', () => {
  for (const entry of MCP_MARKET_CATALOG) {
    assert.ok(MCP_MARKET_CATEGORIES.includes(entry.category), `category is not offered by the filter chips: ${entry.category}`);
  }
  assert.equal(new Set(MCP_MARKET_CATEGORIES).size, MCP_MARKET_CATEGORIES.length, 'filter categories should be unique');
});

test('entries that need secrets declare them and install disabled', () => {
  const withSecrets = MCP_MARKET_CATALOG.filter((entry) => (entry.requiresEnv ?? []).length > 0);
  assert.ok(withSecrets.length >= 3, 'catalog should mark the API-key servers');

  for (const entry of withSecrets) {
    for (const item of entry.requiresEnv) {
      assert.match(item.name, /^[A-Z][A-Z0-9_]*$/, `${entry.key} requires a badly named variable: ${item.name}`);
      assert.ok(item.hint?.trim(), `${entry.key} should explain where to get ${item.name}`);
    }
    const server = createServerFromMarketEntry(entry);
    assert.equal(server.id, MARKET_ID_PREFIX + entry.key);
    assert.equal(server.enabled, false, `${entry.key} must not be enabled before its key is filled in`);
  }

  for (const entry of MCP_MARKET_CATALOG.filter((item) => !(item.requiresEnv ?? []).length)) {
    assert.equal(createServerFromMarketEntry(entry).enabled, true, `${entry.key} needs no secret and should be ready to use`);
  }
});

test('placeholders resolve against the live vault and database paths', () => {
  assert.deepEqual(
    resolveMarketArgs(byKey('filesystem'), { vaultDir: 'D:/notes' }),
    ['-y', '@modelcontextprotocol/server-filesystem', 'D:/notes'],
  );
  assert.deepEqual(
    resolveMarketArgs(byKey('sqlite'), { dbFile: 'D:/data/lattice.db' }),
    ['mcp-server-sqlite', '--db-path', 'D:/data/lattice.db'],
  );
});

test('placeholders fall back to entry defaults, and never silently disappear', () => {
  assert.equal(resolveMarketArgs(byKey('filesystem'))[2], '.');
  assert.equal(resolveMarketArgs(byKey('sqlite'))[2], './data/lattice.db');

  // 空串 / 纯空白视为没有提供上下文，保留占位符以便用户自行补齐。
  assert.deepEqual(resolveMarketArgs({ args: ['{vaultDir}'] }, { vaultDir: '   ' }), ['{vaultDir}']);
  assert.deepEqual(resolveMarketArgs({ args: ['{vaultDir}'] }, { vaultDir: '' }), ['{vaultDir}']);
  assert.deepEqual(resolveMarketArgs({ args: ['{unknown}'] }, { vaultDir: 'D:/notes' }), ['{unknown}']);

  // 只替换「整段即占位符」的参数：内嵌写法保持原样，避免误删命令行片段。
  assert.deepEqual(resolveMarketArgs({ args: ['--path={vaultDir}'] }, { vaultDir: 'D:/notes' }), ['--path={vaultDir}']);
  assert.deepEqual(resolveMarketArgs({ args: [] }, {}), []);
  assert.deepEqual(resolveMarketArgs({}, {}), []);
});

test('installing an entry yields a stdio config bound to the workspace', () => {
  const entry = byKey('filesystem');
  const server = createServerFromMarketEntry(entry, { vaultDir: 'D:/notes' });

  assert.equal(server.id, MARKET_ID_PREFIX + entry.key);
  assert.equal(server.key, entry.key);
  assert.equal(server.name, entry.name);
  assert.equal(server.description, entry.tagline);
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', '@modelcontextprotocol/server-filesystem', 'D:/notes']);
  assert.equal(server.transport, 'stdio');
  assert.equal(server.enabled, true);
  assert.deepEqual(server.tools, entry.tools);
  assert.deepEqual(server.requiresEnv, []);
  assert.equal(server.env.OBSIDIAN_HOST, undefined);

  const obsidian = createServerFromMarketEntry(byKey('obsidian'));
  assert.equal(obsidian.env.OBSIDIAN_HOST, '127.0.0.1:27124');
  // 密钥清单要带到配置里，编辑器才能按变量名给出输入框
  assert.deepEqual(obsidian.requiresEnv, byKey('obsidian').requiresEnv);
});

test('installed detection matches by market id or by imported key', () => {
  const entry = byKey('memory');
  assert.equal(isMarketEntryInstalled([], entry), false);
  assert.equal(isMarketEntryInstalled(undefined, entry), false);
  assert.equal(isMarketEntryInstalled([{ id: MARKET_ID_PREFIX + entry.key, key: 'whatever' }], entry), true);
  assert.equal(isMarketEntryInstalled([{ id: 'mcp-import-memory', key: 'memory' }], entry), true);
  assert.equal(isMarketEntryInstalled([{ id: 'lattice-local', key: 'lattice' }], entry), false);
});

test('appending a market server keeps the builtin entry when the list has not loaded yet', () => {
  const server = createServerFromMarketEntry(byKey('time'));
  const builtin = { id: 'lattice-local', key: 'lattice' };

  // 已保存列表为空（info 未返回 / 读取失败）时，以界面回退展示的列表为基线。
  assert.deepEqual(appendMarketServer([], [builtin], server), [builtin, server]);
  assert.deepEqual(appendMarketServer(undefined, [builtin], server), [builtin, server]);
  assert.deepEqual(appendMarketServer([], undefined, server), [server]);

  // 已有持久化列表时只追加，不重复注入回退项。
  const saved = [builtin, { id: 'mcp-import-x', key: 'x' }];
  assert.deepEqual(appendMarketServer(saved, [builtin], server), [...saved, server]);
  assert.equal(appendMarketServer(saved, [builtin], server).length, 3);
});
