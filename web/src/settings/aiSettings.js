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

export const DEFAULT_AI_SETTINGS = Object.freeze({
  providers: [DEFAULT_PROVIDER],
  activeProviderId: DEFAULT_PROVIDER.id,
  accessToken: '',
  role: 'editor',
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
    accessToken: typeof value?.accessToken === 'string' ? value.accessToken.slice(0, 500) : '',
    role: ['viewer', 'editor', 'admin'].includes(value?.role) ? value.role : 'editor',
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
  };
}
