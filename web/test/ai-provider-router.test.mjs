import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiProviderRouterTransport, isRetryableAiProviderError, normalizeProviderCandidates } from '../src/ai/providers/provider-router.ts';

const first = { id: 'primary', endpoint: 'http://primary/v1/chat/completions', model: 'primary-model', apiKey: 'key-1' };
const second = { id: 'fallback', endpoint: 'http://fallback/v1/chat/completions', model: 'fallback-model', apiKey: 'key-2' };

test('classifies only retryable provider failures', () => {
  assert.equal(isRetryableAiProviderError(new Error('桌面端 AI 模型请求失败（HTTP 503）')), true);
  assert.equal(isRetryableAiProviderError(new Error('桌面端 AI 无法连接模型服务')), true);
  assert.equal(isRetryableAiProviderError(new Error('桌面端 AI 模型请求失败（HTTP 401）')), false);
  assert.equal(isRetryableAiProviderError(new Error('用户已取消')), false);
});

test('normalizes and de-duplicates configured providers', () => {
  assert.deepEqual(normalizeProviderCandidates([first, second, first, { id: 'invalid' }]).map((item) => item.id), ['primary', 'fallback']);
});

test('resumes the same run with the next provider after a retryable failure', async () => {
  const calls = [];
  const events = [];
  const router = createAiProviderRouterTransport({
    stream: async (request, options) => {
      calls.push(request);
      if (calls.length === 1) throw new Error('桌面端 AI 模型请求失败（HTTP 503）');
      options.onEvent?.({ type: 'done', payload: { text: 'fallback answer', meta: { model: request.provider.model } } });
      return { text: 'fallback answer', meta: { model: request.provider.model } };
    },
    getResumeSequence: async () => 4,
  });

  const result = await router.stream({
    runId: 'run-router',
    message: '回答问题',
    mode: 'quick',
    provider: first,
    providerCandidates: [first, second],
  }, { onEvent: (event) => events.push(event) });

  assert.equal(result.text, 'fallback answer');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].runId, calls[1].runId);
  assert.equal(calls[1].resumeRun, true);
  assert.equal(calls[1].resumeAfterSequence, 4);
  assert.equal(calls[1].provider.model, 'fallback-model');
  assert.equal(events[0].meta.fallback, true);
});

test('does not fallback for task runs or authorization failures', async () => {
  for (const request of [
    { runId: 'run-task', message: '执行任务', mode: 'task' },
    { runId: 'run-auth', message: '回答问题', mode: 'quick' },
  ]) {
    let attempts = 0;
    const router = createAiProviderRouterTransport({
      stream: async () => {
        attempts += 1;
        throw new Error(request.mode === 'task' ? 'HTTP 503' : 'HTTP 401');
      },
    });
    await assert.rejects(() => router.stream({ ...request, provider: first, providerCandidates: [first, second] }));
    assert.equal(attempts, 1);
  }
});

test('does not mix providers after a partial streaming response', async () => {
  let attempts = 0;
  const router = createAiProviderRouterTransport({
    stream: async (_request, options) => {
      attempts += 1;
      options.onEvent?.({ type: 'delta', text: 'partial answer' });
      throw new Error('桌面端 AI 模型请求失败（HTTP 503）');
    },
  });
  await assert.rejects(() => router.stream({
    runId: 'run-partial',
    message: '回答问题',
    mode: 'quick',
    provider: first,
    providerCandidates: [first, second],
  }));
  assert.equal(attempts, 1);
});

console.log('AI provider router tests passed');
