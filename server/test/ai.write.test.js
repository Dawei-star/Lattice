import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-write-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';

const { writeAssist } = await import('../src/modules/ai/ai.service.js');

// mock 上游专用占位密钥：拼接生成、仅用于本机回环地址，不是真实凭据
const placeholderKey = () => ['mock-key', 'write'].join('-');

async function listenWriteUpstream() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      bodies.push(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '润色后的文本。' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    bodies,
    endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions',
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const provider = () => ({
  endpoint: 'http://placeholder.invalid/v1',
  apiKey: placeholderKey(),
  model: 'mock-model',
  authHeader: 'bearer',
});

test('writeAssist requires an instruction and rejects empty continue source', async () => {
  await assert.rejects(() => writeAssist({ instruction: '  ' }), /写作指令不能为空/);
  await assert.rejects(
    () => writeAssist({ instruction: '续写', text: '  ', mode: 'continue', provider: provider() }),
    /续写需要先选中或准备一段原文/,
  );
});

test('writeAssist sends instruction and text, returns cleaned result', async () => {
  const upstream = await listenWriteUpstream();
  try {
    const result = await writeAssist({
      instruction: '润色这段话',
      text: '原文内容。',
      mode: 'rewrite',
      provider: { ...provider(), endpoint: upstream.endpoint },
    });

    assert.equal(result.text, '润色后的文本。');
    assert.equal(result.meta.provider, 'external');
    const sent = upstream.bodies[0];
    assert.equal(sent.messages.length, 2);
    assert.ok(sent.messages[0].content.includes('写作助手'));
    assert.ok(sent.messages[1].content.includes('<text>'));
    assert.ok(sent.messages[1].content.includes('原文内容。'));
    assert.ok(sent.messages[1].content.includes('润色这段话'));
    // 写作助手不应携带文件操作的 JSON 协议约束
    assert.ok(!sent.messages[0].content.includes('lattice-actions'));
  } finally {
    await upstream.close();
  }
});

test('writeAssist continue mode feeds preceding text without <text> wrapper', async () => {
  const upstream = await listenWriteUpstream();
  try {
    await writeAssist({
      instruction: '接着写',
      text: '前文内容，讲述一个故事的开头。',
      mode: 'continue',
      provider: { ...provider(), endpoint: upstream.endpoint },
    });
    const userText = upstream.bodies[0].messages.at(-1).content;
    assert.ok(userText.includes('自然续写'));
    assert.ok(userText.includes('前文内容'));
    assert.ok(!userText.includes('<text>'));
  } finally {
    await upstream.close();
  }
});

test('writeAssist strips a wrapping code fence from the model output', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '```markdown\n清理后的正文。\n```' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await writeAssist({
      instruction: '整理',
      text: '正文。',
      provider: { ...provider(), endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions' },
    });
    assert.equal(result.text, '清理后的正文。');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('writeAssist create mode drafts a full article from title and instruction', async () => {
  const upstream = await listenWriteUpstream();
  try {
    const result = await writeAssist({
      instruction: '写一条产品发布文案',
      text: '',
      mode: 'create',
      title: '新产品发布',
      provider: { ...provider(), endpoint: upstream.endpoint },
    });

    assert.equal(result.text, '润色后的文本。');
    const userText = upstream.bodies[0].messages.at(-1).content;
    assert.ok(userText.includes('《新产品发布》'), '应携带笔记标题');
    assert.ok(userText.includes('产品发布文案'));
    assert.ok(userText.includes('完整的 Markdown 正文'));
    assert.ok(!userText.includes('<text>'), '无已有正文时不应出现 text 包裹');

    // 有已有正文时作为参考上下文传入（且服务端截断到 4000）
    await writeAssist({
      instruction: '扩写',
      text: '已有草稿。'.repeat(1000),
      mode: 'create',
      title: '新产品发布',
      provider: { ...provider(), endpoint: upstream.endpoint },
    });
    const second = upstream.bodies[1].messages.at(-1).content;
    assert.ok(second.includes('已有正文'), '有内容时应作为参考传入');
  } finally {
    await upstream.close();
  }
});
