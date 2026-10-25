import assert from 'node:assert/strict';
import test from 'node:test';

const { catalogServiceToEntry, mergeCatalogServices } = await import('../src/settings/modelCatalog.ts');
const { PROVIDERS } = await import('../src/settings/aiProviders.ts');

test('catalogServiceToEntry maps known keys to brand logos and carries model info', () => {
  const entry = catalogServiceToEntry({
    key: 'deepseek',
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v2/chat/completions',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'DeepSeek-V9', contextWindowTokens: 256000, nativeTools: true, openWeights: true, promptCostPer1kUsd: 0.0001 },
    ],
  });
  assert.equal(entry.logo, '/provider-logos/deepseek.svg');
  assert.equal(entry.endpoint, 'https://api.deepseek.com/v2/chat/completions');
  assert.deepEqual(entry.models, ['DeepSeek-V9']);
  assert.equal(entry.modelInfo?.[0].openWeights, true);
});

test('catalogServiceToEntry falls back to custom logo for unknown services', () => {
  const entry = catalogServiceToEntry({ key: 'brand-new-gateway', label: '新网关', endpoint: 'https://gw.example.com/v1/chat/completions', local: true });
  assert.equal(entry.logo, '/provider-logos/custom.svg');
  assert.equal(entry.description, '本机离线模型');
  assert.equal(entry.local, true);
});

test('mergeCatalogServices keeps custom first and replaces same-key builtins', () => {
  const merged = mergeCatalogServices([
    { key: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v2/chat/completions', models: [{ id: 'DeepSeek-V9' }] },
    { key: 'brand-new-gateway', label: '新网关', endpoint: 'https://gw.example.com/v1/chat/completions', models: [] },
  ]);
  // custom 恒在首位
  assert.equal(merged[0].key, 'custom');
  // 同 key 内置项被目录替换（新端点生效）
  const deepseek = merged.find((entry) => entry.key === 'deepseek');
  assert.equal(deepseek?.endpoint, 'https://api.deepseek.com/v2/chat/completions');
  assert.deepEqual(deepseek?.models, ['DeepSeek-V9']);
  // 目录独有服务追加，内置其余服务保留
  assert.ok(merged.some((entry) => entry.key === 'brand-new-gateway'));
  assert.ok(merged.some((entry) => entry.key === 'ollama'));
  assert.equal(merged.filter((entry) => entry.key === 'deepseek').length, 1);
  // 内置表未被修改（浅拷贝合并）
  assert.notEqual(PROVIDERS.find((entry) => entry.key === 'deepseek')?.endpoint, 'https://api.deepseek.com/v2/chat/completions');
});
