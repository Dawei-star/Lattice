import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// config 在模块导入时读取环境变量：先把 DB_FILE 指到临时目录，获得一个可控的 Vault
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-rounds-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';

const { chat } = await import('../src/modules/ai/ai.service.js');
const { config } = await import('../src/config/index.js');

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
  apiKey: placeholderKey('rounds'),
  model: 'mock-model',
  authHeader: 'bearer',
});

test('chat sends conversation history and active note content to the provider', async () => {
  const upstream = await listenScriptedUpstream([
    () => JSON.stringify({ reply: '收到', suggestions: [], references: [], actions: [] }),
  ]);
  try {
    const result = await chat({
      message: '继续',
      context: { activeFile: 'notes/a.md', activeFileContent: '独特标记内容XYZ', files: [], folders: [] },
      history: [
        { role: 'user', content: '之前的问题' },
        { role: 'assistant', content: '之前的回答' },
      ],
      provider: providerFor(upstream),
    });

    assert.equal(result.meta.provider, 'external');
    assert.equal(upstream.bodies.length, 1);
    const roles = upstream.bodies[0].messages.map((entry) => entry.role);
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
    const systemText = upstream.bodies[0].messages[0].content;
    assert.ok(systemText.includes('独特标记内容XYZ'), 'system prompt 应包含当前笔记内容');
    assert.equal(upstream.bodies[0].messages.at(-1).content, '继续');
    assert.ok(result.meta.latencyMs >= 0);
    assert.equal(result.meta.rounds, 1);
  } finally {
    await upstream.close();
  }
});

test('chat auto-executes read-only actions and feeds file content back for the final answer', async () => {
  const vaultDir = config.vaultDir;
  fs.mkdirSync(path.join(vaultDir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'notes', 'a.md'), '# 会议纪要\n\n关键结论：项目按期上线。', 'utf8');

  const upstream = await listenScriptedUpstream([
    () => JSON.stringify({ reply: '我先读一下文件。', suggestions: [], references: [], actions: [{ type: 'read', path: 'notes/a.md' }] }),
    (body) => {
      const lastUser = body.messages.at(-1).content;
      return JSON.stringify({ reply: '这份纪要的关键结论是：项目按期上线。', suggestions: [], references: [], actions: [] });
    },
  ]);
  try {
    const result = await chat({
      message: '总结 notes/a.md 的内容',
      context: { files: [], folders: [] },
      provider: providerFor(upstream),
    });

    assert.equal(upstream.bodies.length, 2, '应发起两轮模型调用');
    assert.equal(result.meta.rounds, 2);
    assert.equal(result.reply, '这份纪要的关键结论是：项目按期上线。');
    assert.deepEqual(result.actions, [], '最终回答不应再带 read 动作去走确认流程');
    const toolText = upstream.bodies[1].messages.at(-1).content;
    assert.ok(toolText.includes('自动执行结果'));
    assert.ok(toolText.includes('项目按期上线'), '读取到的文件内容应回填给模型');
  } finally {
    await upstream.close();
  }
});

test('chat keeps mixed actions for preview instead of auto-reading', async () => {
  const upstream = await listenScriptedUpstream([
    () => JSON.stringify({ reply: '计划如下', suggestions: [], references: [], actions: [{ type: 'read', path: 'notes/a.md' }, { type: 'move', path: 'notes/a.md', targetPath: '归档/a.md' }] }),
  ]);
  try {
    const result = await chat({
      message: '看完顺便归档',
      context: { files: [], folders: [] },
      provider: providerFor(upstream),
    });

    assert.equal(upstream.bodies.length, 1, '混合动作不应触发第二轮');
    assert.equal(result.meta.rounds, 1);
    assert.equal(result.actions.length, 2);
    assert.equal(result.actions[1].type, 'move');
  } finally {
    await upstream.close();
  }
});

test('assist mode executes the first batch when the model requests more reads than the per-round cap', async () => {
  const vaultDir = config.vaultDir;
  fs.mkdirSync(path.join(vaultDir, 'notes'), { recursive: true });
  for (let index = 0; index < 7; index += 1) {
    fs.writeFileSync(path.join(vaultDir, 'notes', `r${index}.md`), `# R${index}\n`, 'utf8');
  }
  const readActions = Array.from({ length: 7 }, (_, index) => ({ type: 'read', path: `notes/r${index}.md` }));

  const upstream = await listenScriptedUpstream([
    () => JSON.stringify({ reply: '先读一批。', suggestions: [], references: [], actions: readActions }),
    (body) => {
      const lastUser = body.messages.at(-1).content;
      assert.ok(lastUser.includes('单轮上限'), '截断原因应回填给模型');
      assert.ok(lastUser.includes('【文件 notes/r4.md】'), '前 5 个读取应已执行');
      assert.ok(!lastUser.includes('【文件 notes/r5.md】'), '超出上限的读取不应执行');
      return JSON.stringify({ reply: '读完前 5 个了。', suggestions: [], references: [], actions: [] });
    },
  ]);
  try {
    const result = await chat({
      message: '把 notes 目录里的文件逐个读一遍',
      context: { files: [], folders: [] },
      provider: providerFor(upstream),
    });

    assert.equal(upstream.bodies.length, 2, '超出上限的纯读取应降级执行而不是整体放弃');
    assert.equal(result.meta.rounds, 2);
    assert.equal(result.reply, '读完前 5 个了。');
    assert.deepEqual(result.actions, []);
  } finally {
    await upstream.close();
  }
});

test('chat tolerates fenced JSON with surrounding prose from the model', async () => {
  const upstream = await listenScriptedUpstream([
    () => '好的，这是我的计划：\n\n```json\n{"reply":"计划就绪","suggestions":["确认执行"],"references":[],"actions":[]}\n```\n\n以上。请确认。',
  ]);
  try {
    const result = await chat({
      message: '给个计划',
      context: { files: [], folders: [] },
      provider: providerFor(upstream),
    });

    assert.equal(result.reply, '计划就绪');
    assert.deepEqual(result.suggestions, ['确认执行']);
  } finally {
    await upstream.close();
  }
});
