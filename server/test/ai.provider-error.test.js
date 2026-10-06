import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as aiService from '../src/modules/ai/ai.service.js';
import { streamChatProvider } from '../src/modules/ai/ai.provider.js';

/** 启动一个模拟 OpenAI 兼容上游，按 path 前缀返回不同状态码。 */
async function listenMockUpstream(handlers) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const handler = handlers[req.url.split('?')[0]] ?? (() => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => handler(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), req, res));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions',
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// mock 上游专用占位密钥：拼接生成、仅用于本机回环地址，不是真实凭据
const placeholderKey = (suffix) => ['mock-key', suffix].join('-');

function expectIncludes(haystack, needle, message) {
  assert.ok(String(haystack).includes(needle), message ?? 'expected to include: ' + needle);
}

function expectNotIncludes(haystack, needle, message) {
  assert.ok(!String(haystack).includes(needle), message ?? 'expected not to include: ' + needle);
}

test('connectivity test reports upstream host and detail on 401 without naming a vendor', async () => {
  const upstream = await listenMockUpstream({
    '/v1/chat/completions': (_body, _req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: mock-***-key.', code: 'invalid_api_key' } }));
    },
  });
  try {
    const result = await aiService.testProvider({
      provider: { endpoint: upstream.endpoint, apiKey: placeholderKey('invalid'), model: 'some-model', authHeader: 'bearer' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    expectIncludes(result.error, '外部模型服务返回 401（');
    expectIncludes(result.error, '127.0.0.1:');
    expectIncludes(result.error, 'Incorrect API key provided');
    expectNotIncludes(result.error, '智谱');
    assert.ok(result.latencyMs >= 0);
  } finally {
    await upstream.close();
  }
});

test('connectivity test succeeds on a minimal upstream response', async () => {
  const upstream = await listenMockUpstream({
    '/v1/chat/completions': (body, req, res) => {
      assert.equal(body.max_tokens, 1);
      assert.equal(req.headers.authorization, 'Bearer ' + placeholderKey('valid'));
      res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
    },
  });
  try {
    const result = await aiService.testProvider({
      provider: { endpoint: upstream.endpoint, apiKey: placeholderKey('valid'), model: 'mock-model', authHeader: 'bearer' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.model, 'mock-model');
    assert.equal(result.error, undefined);
  } finally {
    await upstream.close();
  }
});

test('connectivity test maps invalid endpoint and x-api-key auth without throwing', async () => {
  const badEndpoint = await aiService.testProvider({ provider: { endpoint: 'not-a-url', apiKey: placeholderKey('plain'), model: 'm' } });
  assert.equal(badEndpoint.ok, false);
  expectIncludes(badEndpoint.error, 'endpoint 格式不正确');

  const upstream = await listenMockUpstream({
    '/v1/chat/completions': (_body, req, res) => {
      assert.equal(req.headers['x-api-key'], placeholderKey('header'));
      assert.equal(req.headers.authorization, undefined);
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    },
  });
  try {
    const keyed = await aiService.testProvider({
      provider: { endpoint: upstream.endpoint, apiKey: placeholderKey('header'), model: 'm', authHeader: 'x-api-key' },
    });
    assert.equal(keyed.ok, true);
  } finally {
    await upstream.close();
  }
});

test('chat surfaces upstream failure transparently instead of silently falling back', async () => {
  const upstream = await listenMockUpstream({
    '/v1/chat/completions': (_body, _req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }));
    },
  });
  try {
    // v0.2 起取消静默降级：上游失败必须抛错并携带上游详情，
    // 由界面展示「失败原因 + 重试」，避免用户把本地兜底当成模型回答。
    let error;
    try {
      await aiService.chat({
        message: '继续',
        context: { files: [], folders: [] },
        provider: { endpoint: upstream.endpoint, apiKey: placeholderKey('invalid'), model: 'some-model', authHeader: 'bearer' },
      });
      assert.fail('expected the upstream provider error to be thrown');
    } catch (caught) {
      error = caught;
      expectIncludes(error.message, '外部模型服务返回 401（');
      expectIncludes(error.message, '127.0.0.1:');
      expectIncludes(error.message, 'Incorrect API key provided');
      expectNotIncludes(error.message, '智谱');
    }
    assert.equal(error.status, 502);
    assert.equal(error.code, 'AI_PROVIDER_ERROR');
  } finally {
    await upstream.close();
  }
});

test('streamChatProvider falls back to JSON parsing when a gateway ignores stream:true', async () => {
  const upstream = await listenMockUpstream({
    '/v1/chat/completions': (body, _req, res) => {
      assert.equal(body.stream, true, '请求应携带流式标记');
      // 网关忽略 stream:true，直接回整体 JSON
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '网关忽略流式的完整回答' } }] }));
    },
  });
  try {
    let deltas = '';
    const { raw } = await streamChatProvider({
      messages: [{ role: 'user', content: 'ping' }],
      provider: { endpoint: upstream.endpoint, apiKey: placeholderKey('stream-json'), model: 'mock-model', authHeader: 'bearer' },
      onDelta: (text) => { deltas += text; },
    });
    assert.equal(raw, '网关忽略流式的完整回答');
    assert.equal(deltas, raw, '非 SSE 响应应把完整文本通过 onDelta 兜底回调一次');
  } finally {
    await upstream.close();
  }
});

test('streamChatProvider forwards reasoning_content deltas from reasoning models separately', async () => {
  const upstream = await listenMockUpstream({
    '/v1/chat/completions': (_body, _req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      const events = [
        'data: {"choices":[{"delta":{"reasoning_content":"先分析问题…"}}]}',
        'data: {"choices":[{"delta":{"reasoning_content":"再给出结论"}}]}',
        'data: {"choices":[{"delta":{"content":"最终回答"}}]}',
        'data: [DONE]',
      ];
      res.end(events.join('\n\n') + '\n\n');
    },
  });
  try {
    let reasoning = '';
    let deltas = '';
    const { raw, reasoning: fullReasoning } = await streamChatProvider({
      messages: [{ role: 'user', content: 'ping' }],
      provider: { endpoint: upstream.endpoint, apiKey: placeholderKey('reasoning'), model: 'reasoning-model', authHeader: 'bearer' },
      onDelta: (text) => { deltas += text; },
      onReasoning: (text) => { reasoning += text; },
    });
    assert.equal(raw, '最终回答');
    assert.equal(deltas, '最终回答', '正文增量不应混入思维链');
    assert.equal(reasoning, '先分析问题…再给出结论');
    assert.equal(fullReasoning, '先分析问题…再给出结论');
  } finally {
    await upstream.close();
  }
});
