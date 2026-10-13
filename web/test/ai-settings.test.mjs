import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiProvider, getActiveAiProvider, hasEmbeddingAi, hasExternalAi, loadAiSettings, saveAiSettings } from '../src/settings/aiSettings.js';
import { isLocalOllamaEndpoint } from '../src/settings/aiProviders.js';

const values = new Map();
globalThis.localStorage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, value); },
};

test('migrates the legacy single-model settings into an active provider', () => {
  values.set('lattice-ai-settings-v1', JSON.stringify({
    endpoint: 'https://example.com/v1',
    model: 'legacy-model',
    apiKey: 'secret',
    authHeader: 'x-api-key',
  }));

  const settings = loadAiSettings();
  const provider = getActiveAiProvider(settings);
  assert.equal(settings.providers.length, 1);
  assert.equal(provider.endpoint, 'https://example.com/v1/chat/completions');
  assert.equal(provider.model, 'legacy-model');
  assert.equal(provider.authHeader, 'x-api-key');
  assert.equal(provider.apiKey, 'masked:cret');
  assert.doesNotMatch(values.get('lattice-ai-settings-v1'), /secret/);
  assert.equal(hasExternalAi(settings), true);
});

test('stores multiple providers and switches the active provider', () => {
  const first = loadAiSettings();
  const second = createAiProvider({ name: '智谱', endpoint: 'https://example.com/chat/completions', model: 'glm-model', apiKey: 'secret' });
  const settings = saveAiSettings({
    ...first,
    providers: [...first.providers, second],
    activeProviderId: second.id,
  });

  assert.equal(settings.providers.length, 2);
  assert.equal(getActiveAiProvider(settings).name, '智谱');
  assert.equal(getActiveAiProvider(settings).apiKey, 'masked:cret');
  assert.doesNotMatch(values.get('lattice-ai-settings-v1'), /secret/);
  assert.equal(hasExternalAi(settings), true);
});

test('local Ollama works without storing a placeholder key', () => {
  const provider = createAiProvider({ service: 'Ollama', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', apiKey: '' });
  const settings = saveAiSettings({
    ...loadAiSettings(),
    providers: [provider],
    activeProviderId: provider.id,
    embedding: { endpoint: 'http://127.0.0.1:11434/v1', model: 'bge-m3', apiKey: '', enabled: true },
  });
  assert.equal(isLocalOllamaEndpoint(provider.endpoint), true);
  assert.equal(hasExternalAi(settings), true);
  assert.equal(hasEmbeddingAi(settings), true);
  assert.equal(getActiveAiProvider(settings).apiKey, '');
});
