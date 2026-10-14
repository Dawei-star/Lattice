import { aiApi } from '../api/ai.ts';
import { isLocalOllamaEndpoint } from './aiProviders.js';

const STORAGE_KEY = 'lattice-ai-settings-v1';
const SESSION_STORAGE_KEY = 'lattice-ai-session-v1';
const MASK_PREFIX = 'masked:';

// API Keys 只在当前页面生命周期内存在。localStorage 仅保存掩码，
// 服务端 SQLite 是跨会话的唯一密钥事实源。
const volatileProviderKeys = new Map();
let volatileEmbeddingKey = '';
let needsServerMigration = false;

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
  // 默认让确定性查询走本地快路径；关闭后，已配置模型会优先参与回答。
  preferModel: false,
  // 交互模式：快速模式跳过检索和工具；任务模式允许多轮工具执行。
  interactionMode: 'quick',
  // 任务模式：勾选后 AI 以 agent 循环检索和读取；写操作仍必须经过确认预览
  autoApprove: false,
});

export function loadAiSettings() {
  if (typeof localStorage === 'undefined') return cloneDefaults();
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const session = readSessionSettings();
    const legacyToken = typeof stored?.accessToken === 'string' ? stored.accessToken.trim().slice(0, 500) : '';
    if (legacyToken && !session.accessToken) {
      writeSessionSettings({ accessToken: legacyToken });
    }
    const normalized = normalize({ ...stored, accessToken: session.accessToken || legacyToken });
    rememberSecrets(normalized);
    const safe = redactSettings(normalized);
    if (hasPersistedSecrets(stored)) needsServerMigration = true;
    if (hasPersistedSecrets(stored) || legacyToken) persistLocalSettings(stripForStorage(safe));
    return safe;
  } catch {
    return cloneDefaults();
  }
}

export function saveAiSettings(patch) {
  const next = normalize({ ...loadAiSettings(), ...patch });
  rememberSecrets(next);
  const safe = redactSettings(next);
  persistLocalSettings(stripForStorage(safe));
  if (next.accessToken) writeSessionSettings({ accessToken: next.accessToken });
  else removeSessionSettings();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lattice:ai-settings-change', { detail: safe }));
  }
  pushToServer(next);
  return safe;
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
  return Boolean(provider?.enabled !== false && provider?.endpoint?.trim() && (provider?.apiKey?.trim() || isLocalOllamaEndpoint(provider?.endpoint)) && provider?.model?.trim());
}

export function hasEmbeddingAi(settings) {
  const embedding = settings?.embedding;
  return Boolean(embedding?.enabled && embedding?.endpoint?.trim() && (embedding?.apiKey?.trim() || isLocalOllamaEndpoint(embedding?.endpoint)) && embedding?.model?.trim());
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
          .filter((provider) => provider.endpoint && (provider.apiKey || isLocalOllamaEndpoint(provider.endpoint)))
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
            service: provider.service,
            endpoint: provider.endpoint,
            model: provider.model,
            authHeader: provider.authHeader,
            enabled: provider.enabled !== false,
            ...serializedApiKey(provider, volatileProviderKeys.get(provider.id)),
            ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
            ...(provider.maxTokens !== undefined ? { maxTokens: provider.maxTokens } : {}),
            ...(provider.contextWindowTokens !== undefined ? { contextWindowTokens: provider.contextWindowTokens } : {}),
          })),
        activeProviderId: settings.activeProviderId,
        embedding: settings.embedding?.endpoint && (settings.embedding?.apiKey || isLocalOllamaEndpoint(settings.embedding?.endpoint)) && settings.embedding?.model
          ? {
              endpoint: settings.embedding.endpoint,
              model: settings.embedding.model,
              authHeader: settings.embedding.authHeader,
              name: settings.embedding.name ?? 'Embedding',
              ...serializedApiKey(settings.embedding, volatileEmbeddingKey),
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
    const localConfigured = (local.providers ?? []).some((provider) => provider.endpoint && (provider.apiKey || isLocalOllamaEndpoint(provider.endpoint)));
    const serverProviders = Array.isArray(server.providers) ? server.providers.filter((provider) => provider.endpoint && (provider.apiKey || isLocalOllamaEndpoint(provider.endpoint))) : [];
    const patch = {};
    if (serverProviders.length && !localConfigured) {
      patch.providers = serverProviders.map((provider) => normalizeProvider({ ...provider, verified: true }));
      patch.activeProviderId = server.activeProviderId ?? patch.providers[0]?.id;
    }
    if (server.embedding?.endpoint && !local.embedding?.endpoint) {
      patch.embedding = normalizeEmbedding({ ...server.embedding, enabled: true });
    }
    if ('providers' in patch || 'embedding' in patch) return saveAiSettings({ ...local, ...patch });
    if (needsServerMigration) {
      needsServerMigration = false;
      pushToServer(local);
    }
    return local;
  } catch {
    return loadAiSettings();
  }
}

function cloneDefaults() {
  return normalize(DEFAULT_AI_SETTINGS);
}

function readSessionSettings() {
  try {
    const value = typeof sessionStorage === 'undefined' ? null : JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) ?? '{}');
    return { accessToken: typeof value?.accessToken === 'string' ? value.accessToken.trim().slice(0, 500) : '' };
  } catch {
    return { accessToken: '' };
  }
}

function writeSessionSettings(value) {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Session storage may be unavailable in private browser contexts.
  }
}

function removeSessionSettings() {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Session storage may be unavailable in private browser contexts.
  }
}

function persistLocalSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Local-only settings may be unavailable in private browser contexts.
  }
}

function stripForStorage(settings) {
  return { ...settings, accessToken: '' };
}

function hasPersistedSecrets(value) {
  return Boolean(
    isActualApiKey(value?.apiKey)
      || isActualApiKey(value?.accessToken)
      || value?.providers?.some?.((provider) => isActualApiKey(provider?.apiKey))
      || isActualApiKey(value?.embedding?.apiKey),
  );
}

function isActualApiKey(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith(MASK_PREFIX);
}

export function isMaskedApiKey(value) {
  return typeof value === 'string' && value.startsWith(MASK_PREFIX);
}

function maskApiKey(value) {
  return isActualApiKey(value) ? `${MASK_PREFIX}${value.slice(-4)}` : value ?? '';
}

function redactSettings(settings) {
  return {
    ...settings,
    providers: (settings.providers ?? []).map((provider) => ({ ...provider, apiKey: maskApiKey(provider.apiKey) })),
    embedding: settings.embedding ? { ...settings.embedding, apiKey: maskApiKey(settings.embedding.apiKey) } : settings.embedding,
  };
}

function rememberSecrets(settings) {
  for (const provider of settings.providers ?? []) {
    if (isActualApiKey(provider.apiKey)) volatileProviderKeys.set(provider.id, provider.apiKey);
    else if (provider.apiKey === '') volatileProviderKeys.delete(provider.id);
  }
  if (isActualApiKey(settings.embedding?.apiKey)) volatileEmbeddingKey = settings.embedding.apiKey;
  else if (settings.embedding?.apiKey === '') volatileEmbeddingKey = '';
}

function serializedApiKey(provider, volatileKey) {
  if (isLocalOllamaEndpoint(provider.endpoint) && !provider.apiKey) return { apiKey: '' };
  if (isActualApiKey(provider.apiKey)) return { apiKey: provider.apiKey };
  if (volatileKey) return { apiKey: volatileKey };
  // masked: 值故意省略，服务端会保留原有密钥。
  return {};
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
    preferModel: value?.preferModel === true,
    interactionMode: value?.interactionMode === 'task' || value?.autoApprove === true ? 'task' : 'quick',
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
