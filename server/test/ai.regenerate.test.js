import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// config 在模块导入时读取环境变量：先把 DB_FILE 指到临时目录，获得可控的库与 Vault
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-regen-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';
// mock 上游走本机回环地址，需显式放行 SSRF 防护
process.env.AI_ALLOW_PRIVATE_ENDPOINTS = 'true';

const { chat } = await import('../src/modules/ai/ai.service.js');
const sessions = await import('../src/modules/ai/ai.sessions.js');
const { openDatabase } = await import('../src/db/index.js');
const { runMigrations } = await import('../src/db/migrate.js');
openDatabase();
runMigrations();

const placeholderKey = (suffix) => ['mock-key', suffix].join('-');

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
      res.end(JSON.stringify({
        choices: [{ message: { content: script[step](body) } }],
        usage: { prompt_tokens: 10 + bodies.length, completion_tokens: 5, total_tokens: 15 + bodies.length },
      }));
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
  apiKey: placeholderKey('regen'),
  model: 'mock-model',
  authHeader: 'bearer',
});

test('dropLastTurn removes only the trailing user+assistant pair', async () => {
  const sessionId = 'sess-drop-test';
  sessions.createSession({ id: sessionId, expertId: 'general' });
  sessions.appendMessage(sessionId, { role: 'user', content: '第一问' });
  sessions.appendMessage(sessionId, { role: 'assistant', content: '第一答' });
  // 跨毫秒，确保时间戳可区分；末尾留一条没有回答的 user 消息
  await new Promise((resolve) => setTimeout(resolve, 3));
  sessions.appendMessage(sessionId, { role: 'user', content: '第二问' });

  assert.equal(sessions.dropLastTurn(sessionId), true);
  // 删的是第一对；末尾悬挂的「第二问」不是任何 assistant 的配对，应保留
  assert.deepEqual(sessions.listMessages(sessionId).map((message) => message.content), ['第二问']);
  // 没有 assistant 了，再删是无操作
  assert.equal(sessions.dropLastTurn(sessionId), false);
  assert.deepEqual(sessions.listMessages(sessionId).map((message) => message.content), ['第二问']);
});

test('chat with regenerate:true drops the previous turn from history and store', async () => {
  const sessionId = 'sess-regen-e2e';
  const upstream = await listenScriptedUpstream([
    (body) => {
      // 首次请求：只有当前问题，没有历史
      assert.equal(body.messages.filter((message) => message.role === 'user').length, 1);
      return '第一次的回答';
    },
    (body) => {
      // 重新生成请求：上一轮（同一问题的旧回答）不应出现在模型上下文里
      const userTurns = body.messages.filter((message) => message.role === 'user');
      assert.equal(userTurns.length, 1, '旧的用户消息不应重复进入上下文');
      assert.ok(!body.messages.some((message) => message.content === '第一次的回答'), '旧回答不应进入上下文');
      return '重新生成后的回答';
    },
  ]);
  try {
    const input = {
      message: '解释一下大纲',
      context: { files: [], folders: [] },
      sessionId,
      preferModel: true,
      provider: providerFor(upstream),
    };
    const first = await chat(input);
    assert.equal(first.reply, '第一次的回答');
    assert.equal(first.meta.usage.total_tokens, 16, '上游 usage 应透传到 meta');
    assert.equal(sessions.listMessages(sessionId).length, 2);

    const second = await chat({ ...input, regenerate: true });
    assert.equal(second.reply, '重新生成后的回答');
    assert.equal(sessions.listMessages(sessionId).length, 2, '库里仍只有一轮 user+assistant');
    assert.deepEqual(sessions.listMessages(sessionId).map((message) => message.content), ['解释一下大纲', '重新生成后的回答']);
    assert.equal(upstream.bodies.length, 2);
  } finally {
    await upstream.close();
  }
});
