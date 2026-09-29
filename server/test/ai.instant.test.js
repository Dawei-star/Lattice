import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { chat } = await import('../src/modules/ai/ai.service.js');

/** 会计数的 mock 上游：如果快路径失效、请求落到模型，这里能立刻发现 */
async function listenCountingUpstream() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: '模型回答', actions: [] }) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    get calls() { return calls; },
    endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions',
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const providerFor = (upstream) => ({
  endpoint: upstream.endpoint,
  apiKey: ['instant', 'mock', 'key'].join('-'),
  model: 'mock-model',
  authHeader: 'bearer',
});

test('recent-notes question answers instantly without calling the model', async () => {
  const upstream = await listenCountingUpstream();
  try {
    const result = await chat({
      message: '搜索最近修改的项目笔记',
      context: {
        files: [
          { id: 'a', title: '早的', path: '早的.md', updatedAt: '2026-09-28T01:00:00.000Z' },
          { id: 'b', title: '晚的', path: '晚的.md', updatedAt: '2026-09-28T10:00:00.000Z' },
        ],
        folders: [],
      },
      provider: providerFor(upstream),
    });

    assert.equal(upstream.calls, 0, '快路径不应调用模型');
    assert.equal(result.meta.provider, 'local-instant');
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].id, 'b', '应按更新时间倒序');
    assert.match(result.references[0].excerpt, /更新于/);
  } finally {
    await upstream.close();
  }
});

test('preferModel bypasses the local instant path and calls the configured model', async () => {
  const upstream = await listenCountingUpstream();
  try {
    const result = await chat({
      message: '搜索最近修改的项目笔记',
      preferModel: true,
      context: {
        files: [{ id: 'a', title: '项目笔记', path: '项目笔记.md', updatedAt: '2026-09-29T10:00:00.000Z' }],
        folders: [],
      },
      provider: providerFor(upstream),
    });

    assert.equal(upstream.calls, 1, '模型优先模式应调用上游模型');
    assert.equal(result.meta.provider, 'external');
    assert.equal(result.reply, '模型回答');
  } finally {
    await upstream.close();
  }
});

test('markdown lint runs locally on the active note content', async () => {
  const upstream = await listenCountingUpstream();
  try {
    const result = await chat({
      message: '检查当前笔记的 Markdown 问题',
      context: {
        activeFile: 'notes/demo.md',
        activeFileContent: '# 标题\n\n### 跳级标题\n\n[](target.md)\n\n正文 [文字]()\n\n```js\n未闭合 = true\n',
        files: [],
        folders: [],
      },
      provider: providerFor(upstream),
    });

    assert.equal(upstream.calls, 0);
    assert.equal(result.meta.provider, 'local-instant');
    assert.match(result.reply, /跳级|层级/);
    assert.match(result.reply, /未闭合/);
    assert.match(result.reply, /链接/);
  } finally {
    await upstream.close();
  }
});

test('search with a filename still goes through the instant path', async () => {
  const upstream = await listenCountingUpstream();
  try {
    const result = await chat({
      message: '搜索 demo.md',
      context: { files: [{ id: 'x', title: 'demo', path: 'demo.md' }], folders: [] },
      provider: providerFor(upstream),
    });

    assert.equal(upstream.calls, 0);
    assert.equal(result.meta.provider, 'local-instant');
    assert.ok(result.reply.includes('demo.md'));
  } finally {
    await upstream.close();
  }
});

test('messages that combine search with file actions are NOT hijacked by the instant path', async () => {
  const upstream = await listenCountingUpstream();
  try {
    const result = await chat({
      message: '看完顺便归档',
      context: { files: [], folders: [] },
      provider: providerFor(upstream),
    });
    assert.equal(upstream.calls, 1);
    assert.equal(result.meta.provider, 'external');

    const result2 = await chat({
      message: '搜索部署相关的笔记然后删除它们',
      context: { files: [], folders: [] },
      provider: providerFor(upstream),
    });
    assert.equal(upstream.calls, 2);
    assert.equal(result2.meta.provider, 'external');
  } finally {
    await upstream.close();
  }
});
