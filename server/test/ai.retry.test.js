import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';

const { callChatProvider, streamChatProvider } = await import('../src/modules/ai/ai.provider.js');
const { AiProviderError } = await import('../src/lib/errors.js');

const placeholderKey = (suffix) => ['mock-key', suffix].join('-');

test('non-stream chat: 429 retried once then succeeds (real handler)', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    void req;
    hits += 1;
    if (hits === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '重试成功' } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await callChatProvider({
      messages: [{ role: 'user', content: '你好' }],
      provider: { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions', apiKey: placeholderKey('r'), model: 'm' },
    });
    assert.equal(result.raw, '重试成功');
    assert.equal(result.meta.usage.total_tokens, 3);
    assert.equal(hits, 2, '应当正好重试一次');
  } finally {
    server.close();
  }
});

test('non-stream chat: 400 is not retried', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    void req;
    hits += 1;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad request' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      () => callChatProvider({
        messages: [{ role: 'user', content: '你好' }],
        provider: { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions', apiKey: placeholderKey('r'), model: 'm' },
      }),
      AiProviderError,
    );
    assert.equal(hits, 1, '参数错误不应重试');
  } finally {
    server.close();
  }
});

test('stream chat: 500 before first packet is retried and stream then completes', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    void req;
    hits += 1;
    if (hits === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"世界"}}]}\n\n');
    res.write('data: {"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const deltas = [];
    const result = await streamChatProvider({
      messages: [{ role: 'user', content: '你好' }],
      provider: { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions', apiKey: placeholderKey('r'), model: 'm' },
      onDelta: (text) => deltas.push(text),
    });
    assert.equal(result.raw, '你好世界');
    assert.equal(result.meta.usage.total_tokens, 4);
    assert.equal(hits, 2, '首包前的 500 应当重试一次');
  } finally {
    server.close();
  }
});

test('stream chat: failure after first packet must not retry', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    void req;
    // 正常吐出首包后立刻断连：此时重试会导致调用方收到重复内容
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n');
    setTimeout(() => res.destroy(), 10);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const deltas = [];
    await assert.rejects(
      () => streamChatProvider({
        messages: [{ role: 'user', content: '你好' }],
        provider: { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions', apiKey: placeholderKey('r'), model: 'm' },
        onDelta: (text) => deltas.push(text),
      }),
    );
    assert.equal(deltas.join(''), '开头');
    assert.equal(hits, 1, '首包之后的中断不应重试');
  } finally {
    server.close();
  }
});
