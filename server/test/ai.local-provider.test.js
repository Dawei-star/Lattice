import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderHeaders, isLocalOllamaEndpoint, testChatProvider, testEmbeddingProvider } from '../src/modules/ai/ai.provider.js';
import { resolveChatProvider } from '../src/modules/ai/ai.settings.js';

const endpoint = 'http://127.0.0.1:11434/v1';

test('only the standard loopback Ollama endpoint can omit an API key', () => {
  assert.equal(isLocalOllamaEndpoint(endpoint), true);
  assert.equal(isLocalOllamaEndpoint(`${endpoint}/chat/completions`), true);
  assert.equal(isLocalOllamaEndpoint('http://127.0.0.1:11435/v1'), false);
  assert.equal(isLocalOllamaEndpoint('http://192.168.1.8:11434/v1'), false);
  assert.equal(isLocalOllamaEndpoint('http://localhost:11434/v1'), false);
  assert.equal(isLocalOllamaEndpoint('http://127.0.0.1:11434/admin'), false);
  assert.deepEqual(buildProviderHeaders({ endpoint, apiKey: '' }), { 'Content-Type': 'application/json' });
  assert.throws(() => buildProviderHeaders({ endpoint: 'https://example.com/v1', apiKey: '' }), /API Key/);
  assert.equal(resolveChatProvider({ endpoint, apiKey: '', model: 'local-model' })?.model, 'local-model');
});

test('local chat and embedding probes send no authorization header', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json(requests.length === 1
      ? { choices: [{ message: { content: 'pong' } }] }
      : { data: [{ embedding: [0.1, 0.2, 0.3] }] });
  };
  try {
    const provider = { endpoint, apiKey: '', model: 'local-model' };
    assert.equal((await testChatProvider({ provider })).ok, true);
    assert.equal((await testEmbeddingProvider({ provider })).ok, true);
    assert.deepEqual(requests.map((request) => new URL(request.url).pathname), ['/v1/chat/completions', '/v1/embeddings']);
    assert.ok(requests.every((request) => !Object.hasOwn(request.options.headers, 'Authorization')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
