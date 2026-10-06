import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// config 在模块导入时读取环境变量：先把 DB_FILE 指到临时目录，获得一个可控的 Vault
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-mcp-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.VAULT_DIR = path.join(runtimeRoot, 'vault');
process.env.NODE_ENV = 'test';

const { chat } = await import('../src/modules/ai/ai.service.js');
const {
  sanitizeMcpServers,
  createMcpRegistry,
  buildMcpPromptSection,
  closeAllMcpConnections,
} = await import('../src/modules/ai/ai.mcp.js');

// 被拉起的是仓库内置的 Lattice MCP Server（与 Claude Desktop 导出配置指向同一文件）
const SERVER_SCRIPT = fileURLToPath(new URL('../../scripts/mcp-server/server.mjs', import.meta.url));

// mock 上游专用占位密钥：拼接生成、仅用于本机回环地址，不是真实凭据
const placeholderKey = (suffix) => ['mock-key', suffix].join('-');

/** 按请求次数返回脚本化响应，并记录收到的请求体 */
async function listenScriptedUpstream(script) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      bodies.push(body);
      const step = Math.min(bodies.length, script.length) - 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: script[step](body) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    bodies,
    endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions',
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const providerFor = (upstream) => ({
  endpoint: upstream.endpoint,
  apiKey: placeholderKey('mcp'),
  model: 'mock-model',
  authHeader: 'bearer',
});

const latticeServerConfig = () => ({
  key: 'lattice',
  name: 'Lattice',
  transport: 'stdio',
  command: process.execPath,
  args: [SERVER_SCRIPT],
  env: {
    DB_FILE: path.join(runtimeRoot, 'lattice.db'),
    VAULT_DIR: path.join(runtimeRoot, 'vault'),
    AUTO_MIGRATE: 'true',
  },
});

test('sanitizeMcpServers keeps valid entries and drops broken ones', () => {
  const sanitized = sanitizeMcpServers([
    latticeServerConfig(),
    { key: 'no-command', transport: 'stdio' },
    { key: 'bad-url', transport: 'sse', url: 'ftp://x' },
    { key: 'lattice', transport: 'stdio', command: 'dup' }, // 同名去重，先到先得
    null,
    'junk',
  ]);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].key, 'lattice');
  assert.equal(sanitized[0].command, process.execPath);
  assert.deepEqual(sanitizeMcpServers(undefined), []);
});

test('buildMcpPromptSection lists tools and connection failures honestly', () => {
  const section = buildMcpPromptSection(
    [{ server: 'git', name: 'git_status', description: '查看状态', inputSchema: { type: 'object' } }],
    [{ key: 'broken', name: 'Broken', ok: false, error: 'spawn ENOENT' }],
  );
  assert.ok(section.includes('"type":"mcp"'));
  assert.ok(section.includes('[git] git_status'));
  assert.ok(section.includes('Broken（spawn ENOENT）'));
  assert.equal(buildMcpPromptSection([], []), '');
});

test('registry spawns the built-in server, lists read tools only, and executes a call', async () => {
  const registry = await createMcpRegistry([latticeServerConfig()]);
  try {
    assert.deepEqual(registry.status, [{ key: 'lattice', name: 'Lattice', ok: true, toolCount: 8 }]);
    const names = registry.tools.map((tool) => tool.name);
    assert.ok(names.includes('get_vault_statistics'));
    assert.ok(names.includes('search_notes'));
    // 写入工具默认不注册：注册表里不该出现
    assert.ok(!names.includes('create_note'));

    const result = await registry.call({ type: 'mcp', server: 'lattice', tool: 'get_vault_statistics', args: {} });
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'stdio');
    assert.ok(result.text.includes('noteCount') || result.text.includes('notes'), `应返回统计 JSON：${result.text.slice(0, 120)}`);

    const missing = await registry.call({ type: 'mcp', server: 'ghost', tool: 'x', args: {} });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /ghost/);
  } finally {
    registry.release();
    await closeAllMcpConnections();
  }
});

test('chat loop auto-executes an mcp action and feeds the result back for the final answer', async () => {
  const upstream = await listenScriptedUpstream([
    () => [
      '我先查一下知识库规模。',
      '', '```lattice-actions',
      JSON.stringify([{ type: 'mcp', server: 'lattice', tool: 'get_vault_statistics', args: {} }]),
      '```',
    ].join('\n'),
    (body) => {
      // 第二轮的上下文里应该已经回填了工具结果
      const feedback = body.messages.at(-1).content;
      assert.match(feedback, /【MCP lattice\/get_vault_statistics】/);
      return JSON.stringify({ reply: '知识库目前还是空的，规模统计见工具结果。', suggestions: [], references: [], actions: [] });
    },
  ]);
  try {
    const result = await chat({
      message: '统计一下知识库规模',
      context: { files: [], folders: [] },
      provider: providerFor(upstream),
      preferModel: true,
      mcpServers: [latticeServerConfig()],
    });
    assert.equal(result.meta.provider, 'external');
    assert.match(result.reply, /知识库/);
    // system prompt 里带 MCP 工具清单
    assert.match(upstream.bodies[0].messages[0].content, /\[lattice\] get_vault_statistics/);
    assert.ok(result.meta.mcp?.toolCount >= 8);
  } finally {
    await upstream.close();
    await closeAllMcpConnections();
  }
});

test('chat repairs a model that only promises an MCP tool without emitting an action', async () => {
  const upstream = await listenScriptedUpstream([
    () => '我先用 get_vault_statistics 实际演示一下，看看当前状态。',
    (body) => {
      assert.match(body.messages.at(-1).content, /【MCP lattice\/get_vault_statistics】/);
      return JSON.stringify({ reply: '已读取知识库状态，结果如下。', suggestions: [], references: [], actions: [] });
    },
  ]);
  try {
    const result = await chat({
      message: '实际读取一下知识库状态',
      context: { files: [], folders: [] },
      provider: providerFor(upstream),
      preferModel: true,
      mcpServers: [latticeServerConfig()],
    });
    assert.equal(upstream.bodies.length, 2);
    assert.equal(result.meta.toolExecutions.length, 1);
    assert.equal(result.meta.toolExecutions[0].tool, 'get_vault_statistics');
    assert.equal(result.meta.toolExecutions[0].transport, 'stdio');
  } finally {
    await upstream.close();
    await closeAllMcpConnections();
  }
});

test('short confirmation continues a promised MCP task instead of restarting the conversation', async () => {
  let initialBody = null;
  let feedbackBody = null;
  const upstream = await listenScriptedUpstream([
    (body) => {
      initialBody = body;
      return [
      '现在执行上一轮承诺的工具。',
      '', '```lattice-actions',
      JSON.stringify([{ type: 'mcp', server: 'lattice', tool: 'get_vault_statistics', args: {} }]),
      '```',
      ].join('\n');
    },
    (body) => {
      feedbackBody = body;
      return JSON.stringify({ reply: '知识库状态已经读取完成。', suggestions: [], references: [], actions: [] });
    },
  ]);
  try {
    const request = {
      context: { files: [], folders: [] },
      provider: providerFor(upstream),
      preferModel: true,
      history: [
        { role: 'user', content: '读取知识库状态' },
        { role: 'assistant', content: '我先用 get_vault_statistics 实际演示一下，看看当前状态。' },
      ],
      mcpServers: [latticeServerConfig()],
    };
    const secondResult = await chat({ ...request, message: '好的' });
    assert.equal(secondResult.reply, '知识库状态已经读取完成。');
    const current = initialBody?.messages?.at(-1)?.content ?? '';
    assert.match(current, /系统续接要求/);
    assert.match(current, /立即执行/);
    assert.match(feedbackBody?.messages?.at(-1)?.content ?? '', /【MCP lattice\/get_vault_statistics】/);
    assert.equal(secondResult.meta.toolExecutions.length, 1);
    assert.equal(upstream.bodies.length, 2, '确认词应续接上一轮任务并完成一次工具调用');
  } finally {
    await upstream.close();
    await closeAllMcpConnections();
  }
});

test('chat works unchanged when no mcp servers are provided', async () => {
  const upstream = await listenScriptedUpstream([
    () => JSON.stringify({ reply: '普通回答', suggestions: [], references: [], actions: [] }),
  ]);
  try {
    const result = await chat({
      message: '打个招呼',
      context: { files: [], folders: [] },
      provider: providerFor(upstream),
      preferModel: true,
    });
    assert.equal(result.reply, '普通回答');
    assert.equal(result.meta.mcp, undefined);
    assert.ok(!upstream.bodies[0].messages[0].content.includes('mcp-tools'));
  } finally {
    await upstream.close();
  }
});
