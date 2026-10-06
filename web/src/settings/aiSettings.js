import { aiApi } from '../api/ai.js';

const STORAGE_KEY = 'lattice-ai-settings-v1';

const DEFAULT_PROVIDER = Object.freeze({
  id: 'provider-default',
  name: '默认模型',
  service: '自定义 (OpenAI Compatible)',
  endpoint: '',
  model: 'gpt-4o-mini',
  apiKey: '',
  authHeader: 'bearer',
  enabled: true,
});

export const DEFAULT_EMBEDDING = Object.freeze({
  endpoint: '',
  model: '',
  apiKey: '',
  authHeader: 'bearer',
  enabled: false,
});

export const DEFAULT_AI_SETTINGS = Object.freeze({
  providers: [DEFAULT_PROVIDER],
  activeProviderId: DEFAULT_PROVIDER.id,
  embedding: DEFAULT_EMBEDDING,
  accessToken: '',
  role: 'editor',
  // 默认让确定性查询走本地快路径；关闭后，已配置模型会优先参与回答。
  preferModel: false,
  // 任务模式：勾选后 AI 以 agent 循环执行任务，写操作免逐批确认（全部动作照常审计）
  autoApprove: false,
});

export function loadAiSettings() {
  if (typeof localStorage === 'undefined') return cloneDefaults();
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return cloneDefaults();
  }
}

export function saveAiSettings(patch) {
  const next = normalize({ ...loadAiSettings(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Local-only settings may be unavailable in private browser contexts.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lattice:ai-settings-change', { detail: next }));
  }
  pushToServer(next);
  return next;
}

export function subscribeAiSettings(listener) {
  if (typeof window === 'undefined') return () => {};
  const handleChange = (event) => listener(event.detail ?? loadAiSettings());
  window.addEventListener('lattice:ai-settings-change', handleChange);
  return () => window.removeEventListener('lattice:ai-settings-change', handleChange);
}

export function createAiProvider(overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return normalizeProvider({
    ...DEFAULT_PROVIDER,
    id: `provider-${Date.now()}-${suffix}`,
    name: '新模型',
    service: '自定义 (OpenAI Compatible)',
    model: '',
    ...overrides,
  });
}

export function getActiveAiProvider(settings) {
  const providers = Array.isArray(settings?.providers) ? settings.providers : [];
  return providers.find((provider) => provider.id === settings.activeProviderId) ?? providers[0] ?? null;
}

export function hasExternalAi(settings) {
  const provider = getActiveAiProvider(settings);
  return Boolean(provider?.enabled !== false && provider?.endpoint?.trim() && provider?.apiKey?.trim() && provider?.model?.trim());
}

export function hasEmbeddingAi(settings) {
  const embedding = settings?.embedding;
  return Boolean(embedding?.enabled && embedding?.endpoint?.trim() && embedding?.apiKey?.trim() && embedding?.model?.trim());
}

// ── 服务端同步 ───────────────────────────────────────────────────────
// 模型配置落地服务端（SQLite）：语义索引管道与 CLI 需要在服务端拿到 Key，
// 浏览器 localStorage 只作为界面状态缓存。

/** @type {NodeJS.Timeout | null} */
let pushTimer = null;

function pushToServer(settings) {
  if (typeof window === 'undefined') return; // 测试 / 非浏览器环境
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      await aiApi.putSettings({
        providers: (settings.providers ?? [])
          .filter((provider) => provider.endpoint && provider.apiKey)
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
            service: provider.service,
            endpoint: provider.endpoint,
            model: provider.model,
            apiKey: provider.apiKey,
            authHeader: provider.authHeader,
            enabled: provider.enabled !== false,
            ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
            ...(provider.maxTokens !== undefined ? { maxTokens: provider.maxTokens } : {}),
            ...(provider.contextWindowTokens !== undefined ? { contextWindowTokens: provider.contextWindowTokens } : {}),
          })),
        activeProviderId: settings.activeProviderId,
        embedding: settings.embedding?.endpoint && settings.embedding?.apiKey && settings.embedding?.model
          ? {
              endpoint: settings.embedding.endpoint,
              model: settings.embedding.model,
              apiKey: settings.embedding.apiKey,
              authHeader: settings.embedding.authHeader,
              name: settings.embedding.name ?? 'Embedding',
            }
          : null,
      });
      window.dispatchEvent(new CustomEvent('lattice:ai-server-sync', { detail: { ok: true } }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('lattice:ai-server-sync', { detail: { ok: false, error: error?.message ?? '同步失败' } }));
    }
  }, 600);
}

/**
 * 从服务端补齐配置（应用启动时调用一次）。本地从未配置过模型而服务端已有配置时
 * （重装浏览器 / 换端），采用服务端配置；本地已有配置时以本地为准。
 */
export async function hydrateAiSettingsFromServer() {
  if (typeof window === 'undefined') return loadAiSettings();
  try {
    const response = await aiApi.getSettings();
    const server = response?.data ?? response;
    if (!server || typeof server !== 'object') return loadAiSettings();
    const local = loadAiSettings();
    const localConfigured = (local.providers ?? []).some((provider) => provider.endpoint && provider.apiKey);
    const serverProviders = Array.isArray(server.providers) ? server.providers.filter((provider) => provider.endpoint && provider.apiKey) : [];
    const patch = {};
    if (serverProviders.length && !localConfigured) {
      patch.providers = serverProviders.map((provider) => normalizeProvider({ ...provider, verified: true }));
      patch.activeProviderId = server.activeProviderId ?? patch.providers[0]?.id;
    }
    if (server.embedding?.endpoint && !local.embedding?.endpoint) {
      patch.embedding = normalizeEmbedding({ ...server.embedding, enabled: true });
    }
    if ('providers' in patch || 'embedding' in patch) return saveAiSettings({ ...local, ...patch });
    return local;
  } catch {
    return loadAiSettings();
  }
}

function cloneDefaults() {
  return normalize(DEFAULT_AI_SETTINGS);
}

function normalize(value) {
  const legacyProvider = value?.providers
    ? null
    : value?.endpoint || value?.apiKey || value?.model
      ? { ...DEFAULT_PROVIDER, ...value, id: DEFAULT_PROVIDER.id, name: '默认模型' }
      : null;
  const rawProviders = Array.isArray(value?.providers)
    ? value.providers
    : [legacyProvider ?? DEFAULT_PROVIDER];
  const providers = rawProviders.map(normalizeProvider).filter(Boolean);
  const safeProviders = providers.length ? providers : [normalizeProvider(DEFAULT_PROVIDER)];
  const activeProviderId = safeProviders.some((provider) => provider.id === value?.activeProviderId)
    ? value.activeProviderId
    : safeProviders[0].id;

  return {
    providers: safeProviders,
    activeProviderId,
    embedding: normalizeEmbedding(value?.embedding),
    accessToken: typeof value?.accessToken === 'string' ? value.accessToken.slice(0, 500) : '',
    role: ['viewer', 'editor', 'admin'].includes(value?.role) ? value.role : 'editor',
    preferModel: value?.preferModel === true,
    autoApprove: value?.autoApprove === true,
  };
}

function normalizeProvider(value) {
  if (!value || typeof value !== 'object') return null;
  const rawEndpoint = typeof value.endpoint === 'string' ? value.endpoint.trim().slice(0, 500) : '';
  const endpoint = /\/v1\/?$/i.test(rawEndpoint)
    ? `${rawEndpoint.replace(/\/+$/, '')}/chat/completions`
    : rawEndpoint;
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim().slice(0, 120) : `provider-${Date.now()}`,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 80) : '未命名模型',
    service: typeof value.service === 'string' && value.service.trim() ? value.service.trim().slice(0, 80) : '自定义 (OpenAI Compatible)',
    endpoint,
    model: typeof value.model === 'string' ? value.model.trim().slice(0, 120) : '',
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.slice(0, 500) : '',
    authHeader: value.authHeader === 'x-api-key' ? 'x-api-key' : 'bearer',
    enabled: value.enabled !== false,
    // 只有通过「连通性测试」的配置才允许标记为 verified；界面据此区分「已配置」和「已连接」
    verified: value.verified === true,
    // 高级参数（缺省 undefined = 沿用服务端默认）；随配置一并同步到服务端
    ...(Number.isFinite(Number(value.temperature)) ? { temperature: Math.min(Math.max(Number(value.temperature), 0), 2) } : {}),
    ...(Number.isFinite(Number(value.maxTokens)) && Number(value.maxTokens) >= 1 ? { maxTokens: Math.floor(Number(value.maxTokens)) } : {}),
    ...(Number.isFinite(Number(value.contextWindowTokens)) && Number(value.contextWindowTokens) >= 8_000
      ? { contextWindowTokens: Math.min(Math.floor(Number(value.contextWindowTokens)), 1_000_000) }
      : {}),
  };
}

function normalizeEmbedding(value) {
  const base = { ...DEFAULT_EMBEDDING };
  if (!value || typeof value !== 'object') return base;
  const rawEndpoint = typeof value.endpoint === 'string' ? value.endpoint.trim().slice(0, 500) : '';
  const endpoint = /\/(embeddings|chat\/completions)\/?$/i.test(rawEndpoint)
    ? rawEndpoint
    : /\/v1\/?$/i.test(rawEndpoint)
      ? `${rawEndpoint.replace(/\/+$/, '')}/embeddings`
      : rawEndpoint;
  return {
    endpoint,
    model: typeof value.model === 'string' ? value.model.trim().slice(0, 120) : '',
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.slice(0, 500) : '',
    authHeader: value.authHeader === 'x-api-key' ? 'x-api-key' : 'bearer',
    enabled: value.enabled === true && Boolean(endpoint && value.model?.trim()),
  };
}
