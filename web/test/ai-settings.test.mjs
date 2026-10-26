import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiProvider, getActiveAiProvider, getActiveAiProviderRuntime, getAiProviderRouteRuntime, getSmallModelProviderRuntime, hasEmbeddingAi, hasExternalAi, loadAiSettings, normalizeApprovalPolicy, saveAiSettings } from '../src/settings/aiSettings.ts';
import { isLocalOllamaEndpoint } from '../src/settings/aiProviders.ts';

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

test('small model reuses a configured provider key without persisting it', () => {
  const provider = createAiProvider({ name: '远程主服务', endpoint: 'https://example.com/v1', model: 'large-model', apiKey: 'small-secret' });
  const settings = saveAiSettings({
    ...loadAiSettings(),
    providers: [provider],
    activeProviderId: provider.id,
    smallModelEnabled: true,
    smallModelProviderId: provider.id,
    smallModelName: 'small-model',
  });
  const runtime = getSmallModelProviderRuntime(settings);
  assert.equal(runtime.model, 'small-model');
  assert.equal(runtime.apiKey, 'small-secret');
  assert.doesNotMatch(values.get('lattice-ai-settings-v1'), /small-secret/);
});

test('runtime provider route prioritizes active providers and excludes unusable entries', () => {
  const active = createAiProvider({ id: 'active', name: '活动服务', endpoint: 'https://active.example/v1', model: 'active-model', apiKey: 'active-secret' });
  const fallback = createAiProvider({ id: 'fallback', name: '备用服务', endpoint: 'https://fallback.example/v1', model: 'fallback-model', apiKey: 'fallback-secret' });
  const disabled = createAiProvider({ id: 'disabled', endpoint: 'https://disabled.example/v1', model: 'disabled-model', apiKey: 'disabled-secret', enabled: false });
  const incomplete = createAiProvider({ id: 'incomplete', endpoint: 'https://incomplete.example/v1', model: '', apiKey: 'incomplete-secret' });
  const settings = saveAiSettings({
    ...loadAiSettings(),
    providers: [fallback, disabled, active, incomplete],
    activeProviderId: active.id,
  });

  assert.deepEqual(getAiProviderRouteRuntime(settings).map((provider) => provider.id), ['active', 'fallback']);
  assert.equal(getAiProviderRouteRuntime(settings)[0].apiKey, 'active-secret');
  assert.equal(getAiProviderRouteRuntime(settings)[1].apiKey, 'fallback-secret');
});

// --- W1b：keyAvailable 感知路由（密钥在 env/keyring，客户端只剩掩码） --------------
test('keyring-backed providers pass runtime gates with a masked key only', () => {
  const provider = {
    ...createAiProvider({ name: '远程主服务', endpoint: 'https://example.com/v1', model: 'large-model', apiKey: 'masked:abcd' }),
    keyAvailable: true,
  };
  const settings = saveAiSettings({
    ...loadAiSettings(),
    providers: [provider],
    activeProviderId: provider.id,
  });
  assert.equal(hasExternalAi(settings), true, '掩码 + keyAvailable → 可用（内核请求边界补齐）');
  const runtime = getActiveAiProviderRuntime(settings);
  assert.equal(runtime.apiKey, '', '客户端不带真实密钥，传空串由内核注入');
  const route = getAiProviderRouteRuntime(settings);
  assert.deepEqual(route.map((item) => item.id), [provider.id], 'keyAvailable 提供方进入路由候选');
  assert.equal(route[0].apiKey, '');
});

test('masked keys without keyAvailable still fail closed', () => {
  const provider = createAiProvider({ name: '远程主服务', endpoint: 'https://example.com/v1', model: 'large-model', apiKey: 'masked:abcd' });
  const settings = saveAiSettings({
    ...loadAiSettings(),
    providers: [provider],
    activeProviderId: provider.id,
  });
  assert.equal(hasExternalAi(settings), false, '掩码且无 keyAvailable → 按未配置（W1 热修语义保持）');
  assert.equal(getAiProviderRouteRuntime(settings).length, 0);
});

test('small model gate honors keyAvailable', () => {
  const provider = {
    ...createAiProvider({ name: '远程主服务', endpoint: 'https://example.com/v1', model: 'large-model', apiKey: 'masked:abcd' }),
    keyAvailable: true,
  };
  const settings = saveAiSettings({
    ...loadAiSettings(),
    providers: [provider],
    activeProviderId: provider.id,
    smallModelEnabled: true,
    smallModelProviderId: provider.id,
    smallModelName: 'small-model',
  });
  const runtime = getSmallModelProviderRuntime(settings);
  assert.ok(runtime, 'keyAvailable 放行 small model');
  assert.equal(runtime.apiKey, '');
});

test('normalize keeps the server keyAvailable flag on hydration', () => {
  values.set('lattice-ai-settings-v1', JSON.stringify({
    providers: [{ id: 'p1', name: 'n', endpoint: 'https://example.com/chat/completions', model: 'm', apiKey: 'masked:abcd', keyAvailable: true }],
    activeProviderId: 'p1',
  }));
  const settings = loadAiSettings();
  assert.equal(settings.providers[0].keyAvailable, true, '服务端实测标记随 hydrate 保留');
});

// --- 审批策略：独立于交互模式与模型选择的事实源 ------------------------------
test('approval policy defaults to review and survives a save/load round trip', () => {
  values.clear();
  assert.equal(loadAiSettings().approvalPolicy, 'review', '默认不允许自动跳过 L2 确认');

  const saved = saveAiSettings({ ...loadAiSettings(), interactionMode: 'task', approvalPolicy: 'always' });
  assert.equal(saved.approvalPolicy, 'always');
  assert.equal(loadAiSettings().approvalPolicy, 'always', '重启后保持用户选择');
  assert.equal(loadAiSettings().interactionMode, 'task');
});

test('legacy autoApprove migrates to skip without touching already-stored policy', () => {
  assert.equal(normalizeApprovalPolicy({ autoApprove: true }), 'skip', '老的全自动用户升级后仍是全自动');
  assert.equal(normalizeApprovalPolicy({ autoApprove: false }), 'review', '老的手动用户升级后不放大权限');
  assert.equal(normalizeApprovalPolicy({ approvalPolicy: 'skip', autoApprove: false }), 'skip', '新字段优先于旧布尔');
  assert.equal(normalizeApprovalPolicy({ approvalPolicy: 'nonsense' }), 'review', '非法值 fail closed');
  assert.equal(normalizeApprovalPolicy({}), 'review');
});

test('switching approval policy does not silently change the model preference', () => {
  values.clear();
  const before = saveAiSettings({ ...loadAiSettings(), preferModel: false, interactionMode: 'quick', approvalPolicy: 'review' });
  assert.equal(before.preferModel, false);

  // 菜单只改审批策略（+ 写入所需的交互模式），不再顺带把 preferModel 打开。
  const after = saveAiSettings({ ...loadAiSettings(), interactionMode: 'task', approvalPolicy: 'skip' });
  assert.equal(after.preferModel, false, '跳过审批不应改动模型选择');
});

test('chat-only stays selectable while a legacy autoApprove flag is still stored', () => {
  values.clear();
  values.set('lattice-ai-settings-v1', JSON.stringify({
    providers: [{ id: 'p1', name: 'n', endpoint: 'https://example.com/chat/completions', model: 'm', apiKey: 'masked:abcd' }],
    activeProviderId: 'p1',
    interactionMode: 'task',
    autoApprove: true,
  }));

  const migrated = loadAiSettings();
  assert.equal(migrated.approvalPolicy, 'skip', '旧布尔迁移成跳过审批');
  assert.equal(migrated.interactionMode, 'task');

  const saved = saveAiSettings({ ...migrated, interactionMode: 'quick' });
  assert.equal(saved.interactionMode, 'quick', '旧布尔不能把用户拉回任务模式');
  assert.equal(loadAiSettings().interactionMode, 'quick');
  assert.equal(loadAiSettings().approvalPolicy, 'skip', '审批选择在只对话状态下保留');
});

test('irreversible opt-in is off by default and only persists when enabled', () => {
  values.clear();
  assert.equal(loadAiSettings().allowIrreversible, false, '默认不放弃最后一道防线');

  const enabled = saveAiSettings({ ...loadAiSettings(), interactionMode: 'task', approvalPolicy: 'skip', allowIrreversible: true });
  assert.equal(enabled.allowIrreversible, true);
  assert.equal(loadAiSettings().allowIrreversible, true, '重启后仍保持开启');

  const disabled = saveAiSettings({ ...loadAiSettings(), allowIrreversible: false });
  assert.equal(disabled.allowIrreversible, false);
  assert.equal(loadAiSettings().allowIrreversible, false);
});
