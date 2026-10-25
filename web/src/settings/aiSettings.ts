import { aiApi } from '../api/ai.ts';
import { isLocalOllamaEndpoint } from './aiProviders.ts';

/** 模型供应商配置（归一化后的形态，providers 数组元素）。 */
export interface AiProviderConfig {
  id: string;
  name: string;
  service: string;
  endpoint: string;
  model: string;
  apiKey: string;
  authHeader: 'bearer' | 'x-api-key';
  enabled: boolean;
  /** 只有通过「连通性测试」的配置才为 true；界面据此区分「已配置」和「已连接」 */
  verified?: boolean;
  /** W1b：服务端实测密钥可解析（env→keyring）；真值时客户端可只带掩码，内核请求边界补齐 */
  keyAvailable?: boolean;
  /** W7c 能力实测：probe 确认端点/模型接受工具调用面。false → 任务模式置灰（能力协商链） */
  nativeTools?: boolean;
  temperature?: number;
  maxTokens?: number;
  contextWindowTokens?: number;
  promptCostPer1kUsd?: number;
  completionCostPer1kUsd?: number;
}

/** 语义索引 Embedding 配置。 */
export interface AiEmbeddingConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  authHeader: 'bearer' | 'x-api-key';
  enabled: boolean;
  /** 服务端配置可能带展示名 */
  name?: string;
}

/** AI 设置（localStorage 界面状态缓存 + 服务端同步的客户端形态）。 */
export interface AiSettings {
  providers: AiProviderConfig[];
  activeProviderId: string;
  embedding: AiEmbeddingConfig;
  accessToken: string;
  preferModel: boolean;
  interactionMode: 'quick' | 'task';
  autoApprove: boolean;
  smallModelEnabled: boolean;
  smallModelProviderId: string;
  smallModelName: string;
}

const STORAGE_KEY = 'lattice-ai-settings-v1';
const SESSION_STORAGE_KEY = 'lattice-ai-session-v1';
const MASK_PREFIX = 'masked:';

// API Keys 只在当前页面生命周期内存在。localStorage 仅保存掩码，
// 服务端 SQLite 是跨会话的唯一密钥事实源。
const volatileProviderKeys = new Map<string, string>();
let volatileEmbeddingKey = '';
let needsServerMigration = false;

const DEFAULT_PROVIDER = Object.freeze({
  id: 'provider-default',
  name: '默认模型',
  service: '自定义 (OpenAI Compatible)',
  endpoint: '',
  model: 'gpt-4o-mini',
  apiKey: '',
  authHeader: 'bearer' as AiProviderConfig['authHeader'],
  enabled: true,
});

export const DEFAULT_EMBEDDING: Readonly<AiEmbeddingConfig> = Object.freeze({
  endpoint: '',
  model: '',
  apiKey: '',
  authHeader: 'bearer',
  enabled: false,
});

export const DEFAULT_AI_SETTINGS: Readonly<AiSettings> = Object.freeze({
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
  smallModelEnabled: false,
  smallModelProviderId: '',
  smallModelName: '',
});

export function loadAiSettings(): AiSettings {
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

export function saveAiSettings(patch: Partial<AiSettings>): AiSettings {
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

export function subscribeAiSettings(listener: (settings: AiSettings) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handleChange = (event: Event) => listener((event as CustomEvent<AiSettings | undefined>).detail ?? loadAiSettings());
  window.addEventListener('lattice:ai-settings-change', handleChange);
  return () => window.removeEventListener('lattice:ai-settings-change', handleChange);
}

export function createAiProvider(overrides: Partial<AiProviderConfig> = {}): AiProviderConfig {
  const suffix = Math.random().toString(36).slice(2, 8);
  return normalizeProvider({
    ...DEFAULT_PROVIDER,
    id: `provider-${Date.now()}-${suffix}`,
    name: '新模型',
    service: '自定义 (OpenAI Compatible)',
    model: '',
    ...overrides,
  }) as AiProviderConfig;
}

export function getActiveAiProvider(settings?: AiSettings | null): AiProviderConfig | null {
  const providers = Array.isArray(settings?.providers) ? settings.providers : [];
  return providers.find((provider) => provider.id === (settings as AiSettings).activeProviderId) ?? providers[0] ?? null;
}

/**
 * Desktop-only runtime view. API keys remain masked in UI/local persistence;
 * this accessor exposes the volatile in-memory key only to the Tauri transport.
 */
export function getActiveAiProviderRuntime(settings?: AiSettings | null): AiProviderConfig | null {
  const provider = getActiveAiProvider(settings);
  if (!provider) return null;
  // W1b：keyAvailable=true 时客户端没有（也不需要有）真实 Key——传空串，
  // 内核 provider_from_request 按 env→keyring 优先级补齐（密钥只在请求内存）。
  const apiKey = volatileProviderKeys.get(provider.id) ?? (isActualApiKey(provider.apiKey) ? provider.apiKey : '');
  return { ...provider, apiKey };
}

/** Runtime-only view for the optional remote router/reranker model. */
export function getSmallModelProviderRuntime(settings?: AiSettings | null): AiProviderConfig | null {
  const current = settings ?? loadAiSettings();
  if (current.smallModelEnabled !== true) return null;
  const provider = (current.providers ?? []).find((item) => item.id === current.smallModelProviderId);
  if (!provider || provider.enabled === false) return null;
  const apiKey = volatileProviderKeys.get(provider.id) ?? (isActualApiKey(provider.apiKey) ? provider.apiKey : '');
  const model = current.smallModelName.trim();
  if (!provider.endpoint.trim() || !model || (!apiKey && !isLocalOllamaEndpoint(provider.endpoint) && provider.keyAvailable !== true)) return null;
  return { ...provider, model, apiKey, maxTokens: Math.min(provider.maxTokens ?? 512, 512), temperature: 0 };
}

export function hasSmallModel(settings?: AiSettings | null): boolean {
  return getSmallModelProviderRuntime(settings) !== null;
}

export function hasExternalAi(settings?: AiSettings | null): boolean {
  const provider = getActiveAiProvider(settings);
  if (!provider || provider.enabled === false || !provider.endpoint?.trim() || !provider.model?.trim()) return false;
  if (isLocalOllamaEndpoint(provider.endpoint)) return true;
  // W1b：keyAvailable（服务端按 env→keyring 实测）为真即可用——客户端只剩掩码时
  // 内核会在请求边界补齐真实密钥。否则掩码不等于可用，按未配置处理。
  if (provider.keyAvailable === true) return true;
  const apiKey = volatileProviderKeys.get(provider.id) ?? (isActualApiKey(provider.apiKey) ? provider.apiKey : '');
  return Boolean(apiKey);
}

export function hasEmbeddingAi(settings?: AiSettings | null): boolean {
  const embedding = settings?.embedding;
  return Boolean(embedding?.enabled && embedding?.endpoint?.trim() && (embedding?.apiKey?.trim() || isLocalOllamaEndpoint(embedding?.endpoint)) && embedding?.model?.trim());
}

// ── 服务端同步 ───────────────────────────────────────────────────────
// 模型配置落地服务端（SQLite）：语义索引管道与 CLI 需要在服务端拿到 Key，
// 浏览器 localStorage 只作为界面状态缓存。

let pushTimer: number | null = null;

function pushToServer(settings: AiSettings) {
  if (typeof window === 'undefined') return; // 测试 / 非浏览器环境
  clearTimeout(pushTimer as number);
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
      window.dispatchEvent(new CustomEvent('lattice:ai-server-sync', { detail: { ok: false, error: (error as Error)?.message ?? '同步失败' } }));
    }
  }, 600);
}

/**
 * 从服务端补齐配置（应用启动时调用一次）。本地从未配置过模型而服务端已有配置时
 * （重装浏览器 / 换端），采用服务端配置；本地已有配置时以本地为准。
 */
export async function hydrateAiSettingsFromServer(): Promise<AiSettings> {
  if (typeof window === 'undefined') return loadAiSettings();
  try {
    const response = await aiApi.getSettings();
    const server = (response?.data ?? response) as Record<string, any> | null | undefined;
    if (!server || typeof server !== 'object') return loadAiSettings();
    const local = loadAiSettings();
    const localConfigured = (local.providers ?? []).some((provider) => provider.endpoint && (provider.apiKey || isLocalOllamaEndpoint(provider.endpoint)));
    const serverProviders = Array.isArray(server.providers) ? server.providers.filter((provider: any) => provider.endpoint && (provider.apiKey || isLocalOllamaEndpoint(provider.endpoint))) : [];
    const patch: Partial<AiSettings> = {};
    if (serverProviders.length && !localConfigured) {
      patch.providers = serverProviders.map((provider: any) => normalizeProvider({ ...provider, verified: true })) as AiProviderConfig[];
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

function cloneDefaults(): AiSettings {
  return normalize(DEFAULT_AI_SETTINGS);
}

function readSessionSettings(): { accessToken: string } {
  try {
    const value = typeof sessionStorage === 'undefined' ? null : JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) ?? '{}');
    return { accessToken: typeof value?.accessToken === 'string' ? value.accessToken.trim().slice(0, 500) : '' };
  } catch {
    return { accessToken: '' };
  }
}

function writeSessionSettings(value: { accessToken: string }) {
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

function persistLocalSettings(settings: AiSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Local-only settings may be unavailable in private browser contexts.
  }
}

function stripForStorage(settings: AiSettings): AiSettings {
  return { ...settings, accessToken: '' };
}

function hasPersistedSecrets(value: any): boolean {
  return Boolean(
    isActualApiKey(value?.apiKey)
      || isActualApiKey(value?.accessToken)
      || value?.providers?.some?.((provider: any) => isActualApiKey(provider?.apiKey))
      || isActualApiKey(value?.embedding?.apiKey),
  );
}

function isActualApiKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith(MASK_PREFIX);
}

export function isMaskedApiKey(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(MASK_PREFIX);
}

function maskApiKey(value: any): string {
  return isActualApiKey(value) ? `${MASK_PREFIX}${value.slice(-4)}` : value ?? '';
}

function redactSettings(settings: AiSettings): AiSettings {
  return {
    ...settings,
    providers: (settings.providers ?? []).map((provider) => ({ ...provider, apiKey: maskApiKey(provider.apiKey) })),
    embedding: settings.embedding ? { ...settings.embedding, apiKey: maskApiKey(settings.embedding.apiKey) } : settings.embedding,
  };
}

function rememberSecrets(settings: AiSettings) {
  for (const provider of settings.providers ?? []) {
    if (isActualApiKey(provider.apiKey)) volatileProviderKeys.set(provider.id, provider.apiKey);
    else if (provider.apiKey === '') volatileProviderKeys.delete(provider.id);
  }
  if (isActualApiKey(settings.embedding?.apiKey)) volatileEmbeddingKey = settings.embedding.apiKey;
  else if (settings.embedding?.apiKey === '') volatileEmbeddingKey = '';
}

/**
 * Returns enabled runtime providers in fallback order: active provider first,
 * followed by the remaining configured providers. API keys are resolved from
 * the volatile in-memory map and never from the persisted masked settings.
 */
export function getAiProviderRouteRuntime(settings?: AiSettings | null): AiProviderConfig[] {
  const current = settings ?? loadAiSettings();
  const active = getActiveAiProvider(current);
  const ordered = [active, ...(current.providers ?? []).filter((provider) => provider !== active)];
  const seen = new Set<string>();
  return ordered.flatMap((provider) => {
    if (!provider || seen.has(provider.id) || provider.enabled === false) return [];
    // W1b：keyAvailable=true（env/keyring 可解析）时传空 Key，由内核请求边界补齐
    const apiKey = volatileProviderKeys.get(provider.id) ?? (isActualApiKey(provider.apiKey) ? provider.apiKey : '');
    if (!provider.endpoint.trim() || !provider.model.trim() || (!apiKey && !isLocalOllamaEndpoint(provider.endpoint) && provider.keyAvailable !== true)) return [];
    seen.add(provider.id);
    return [{ ...provider, apiKey }];
  });
}

function serializedApiKey(provider: AiProviderConfig | AiEmbeddingConfig, volatileKey?: string): { apiKey?: string } {
  if (isLocalOllamaEndpoint(provider.endpoint) && !provider.apiKey) return { apiKey: '' };
  if (isActualApiKey(provider.apiKey)) return { apiKey: provider.apiKey };
  if (volatileKey) return { apiKey: volatileKey };
  // masked: 值故意省略，服务端会保留原有密钥。
  return {};
}

function normalize(value: any): AiSettings {
  const legacyProvider = value?.providers
    ? null
    : value?.endpoint || value?.apiKey || value?.model
      ? { ...DEFAULT_PROVIDER, ...value, id: DEFAULT_PROVIDER.id, name: '默认模型' }
      : null;
  const rawProviders = Array.isArray(value?.providers)
    ? value.providers
    : [legacyProvider ?? DEFAULT_PROVIDER];
  const providers = rawProviders.map(normalizeProvider).filter(Boolean) as AiProviderConfig[];
  const safeProviders = (providers.length ? providers : [normalizeProvider(DEFAULT_PROVIDER)]) as AiProviderConfig[];
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
    smallModelEnabled: value?.smallModelEnabled === true,
    smallModelProviderId: typeof value?.smallModelProviderId === 'string' ? value.smallModelProviderId.trim().slice(0, 120) : '',
    smallModelName: typeof value?.smallModelName === 'string' ? value.smallModelName.trim().slice(0, 120) : '',
  };
}

function normalizeProvider(value: any): AiProviderConfig | null {
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
    // W1b：服务端实测的密钥可用性（env→keyring 可解析）；只在真值时保留，缺省视为未知
    ...(value.keyAvailable === true ? { keyAvailable: true } : {}),
    // W7c：probe 实测的工具能力（易失，重启后随下次探测刷新；与服务端无关）
    ...(value.nativeTools === true || value.nativeTools === false ? { nativeTools: value.nativeTools === true } : {}),
    // 高级参数（缺省 undefined = 沿用服务端默认）；随配置一并同步到服务端
    ...(Number.isFinite(Number(value.temperature)) ? { temperature: Math.min(Math.max(Number(value.temperature), 0), 2) } : {}),
    ...(Number.isFinite(Number(value.maxTokens)) && Number(value.maxTokens) >= 1 ? { maxTokens: Math.floor(Number(value.maxTokens)) } : {}),
    ...(Number.isFinite(Number(value.contextWindowTokens)) && Number(value.contextWindowTokens) >= 8_000
      ? { contextWindowTokens: Math.min(Math.floor(Number(value.contextWindowTokens)), 1_000_000) }
      : {}),
    ...(Number.isFinite(Number(value.promptCostPer1kUsd)) && Number(value.promptCostPer1kUsd) >= 0
      ? { promptCostPer1kUsd: Math.min(Number(value.promptCostPer1kUsd), 10_000) }
      : {}),
    ...(Number.isFinite(Number(value.completionCostPer1kUsd)) && Number(value.completionCostPer1kUsd) >= 0
      ? { completionCostPer1kUsd: Math.min(Number(value.completionCostPer1kUsd), 10_000) }
      : {}),
  };
}

function normalizeEmbedding(value: any): AiEmbeddingConfig {
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
