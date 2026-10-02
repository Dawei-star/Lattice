/**
 * 服务端 AI 配置存储（SQLite ai_settings 表）。
 *
 * 此前模型配置只存浏览器 localStorage：换端失忆、CLI 拿不到配置、
 * 服务端 embedding 索引管道更是无从谈起。现在配置落地服务端，
 * 聊天 / 索引 / CLI 共用同一份；浏览器端通过 PUT 同步、GET 读取。
 *
 * 桌面版通过 Electron safeStorage 提供密钥，独立服务可用 AI_SETTINGS_ENCRYPTION_KEY；旧版明文 JSON 仍兼容读取。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../../config/index.js';
import { getDb } from '../../db/index.js';
import { nowIso } from '../../lib/time.js';

const SETTINGS_KEY = 'model-config';
const ENCRYPTED_PREFIX = 'enc:v1:';

const EMPTY = Object.freeze({
  providers: [],
  activeProviderId: null,
  embedding: null,
});

const EMPTY_RESULT = () => ({ ...EMPTY, providers: [], embedding: null });

/**
 * 读取配置。未写入过任何配置时返回空骨架（providers 为空数组）。
 * 数据库尚未迁移（部分测试环境）时同样返回空骨架 —— 配置缺失不应让业务崩掉。
 * @returns {{ providers: Array, activeProviderId: string|null, embedding: object|null }}
 */
export function loadServerSettings() {
  let row = null;
  try {
    const db = getDb();
    row = db.prepare('SELECT value FROM ai_settings WHERE key = ?').get(SETTINGS_KEY);
  } catch {
    return EMPTY_RESULT();
  }
  if (!row) return EMPTY_RESULT();
  try {
    return normalizeSettings(JSON.parse(decodeStoredValue(row.value)));
  } catch (error) {
    if (String(row.value).startsWith(ENCRYPTED_PREFIX)) throw error;
    return EMPTY_RESULT();
  }
}

/** 全量覆盖写入。调用方负责校验结构（路由层 zod）。 */
export function saveServerSettings(patch) {
  const db = getDb();
  const next = normalizeSettings(patch);
  db.prepare(
    'INSERT INTO ai_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(SETTINGS_KEY, encodeStoredValue(JSON.stringify(next)), nowIso());
  return next;
}

/**
 * 启动检查：未配置加密 Key 且数据库里存有明文 API Key 时明确告警。
 * 任何能读到 lattice.db 的进程（备份、云盘同步、恶意软件）都能拿走全部 Key，
 * 至少要让用户在日志里看到这个事实与解决办法。不阻断启动。
 */
export function warnIfPlaintextKeys(log) {
  if (config.aiSettingsEncryptionKey?.trim()) return;
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM ai_settings WHERE key = ?').get(SETTINGS_KEY);
    if (!row || String(row.value).startsWith(ENCRYPTED_PREFIX)) return;
    const settings = normalizeSettings(JSON.parse(row.value));
    const hasKey = settings.providers.some((provider) => provider.apiKey) || Boolean(settings.embedding?.apiKey);
    if (!hasKey) return;
    log.warn('ai_settings_plaintext_keys', {
      hint: 'AI API Key 以明文存储在数据库中。设置 AI_SETTINGS_ENCRYPTION_KEY（32 字节 hex/base64）可启用静态加密，配置后重新保存一次模型设置即可完成加密迁移。',
    });
  } catch {
    // 检查失败不影响启动
  }
}

const MASK_PREFIX = 'masked:';

function encryptionKey() {
  const raw = config.aiSettingsEncryptionKey?.trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;
  const error = new Error('AI_SETTINGS_ENCRYPTION_KEY must be a 32-byte hex or base64 key');
  error.code = 'AI_SETTINGS_KEY_INVALID';
  throw error;
}

function encodeStoredValue(value) {
  const key = encryptionKey();
  if (!key) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decodeStoredValue(value) {
  if (!String(value).startsWith(ENCRYPTED_PREFIX)) return value;
  const key = encryptionKey();
  if (!key) {
    const error = new Error('AI_SETTINGS_ENCRYPTION_KEY is required to read encrypted AI settings');
    error.code = 'AI_SETTINGS_KEY_MISSING';
    throw error;
  }
  const [ivText, tagText, ciphertextText] = String(value).slice(ENCRYPTED_PREFIX.length).split('.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    const error = new Error('Unable to decrypt AI settings; check AI_SETTINGS_ENCRYPTION_KEY');
    error.code = 'AI_SETTINGS_DECRYPT_FAILED';
    throw error;
  }
}

function maskApiKey(apiKey) {
  return apiKey ? `${MASK_PREFIX}${apiKey.slice(-4)}` : '';
}

/**
 * GET /settings 用：apiKey 永不明文下发，只返回 masked:末4位 形式的掩码。
 * 内部消费方（聊天/索引管道）仍读 loadServerSettings 的原始值。
 */
export function maskServerSettings(settings) {
  return {
    ...settings,
    providers: settings.providers.map((provider) => ({ ...provider, apiKey: maskApiKey(provider.apiKey) })),
    embedding: settings.embedding ? { ...settings.embedding, apiKey: maskApiKey(settings.embedding.apiKey) } : null,
  };
}

/**
 * PUT /settings 用：apiKey 缺省或为掩码值时保留现值，前端无需回传明文 Key。
 * provider 按 id 匹配现有配置；embedding 是单对象直接匹配。
 */
export function mergeSettingsPatch(patch, current) {
  const currentById = new Map(current.providers.map((provider) => [provider.id, provider]));
  const providers = (patch.providers ?? []).map((provider) => {
    const existing = currentById.get(typeof provider.id === 'string' && provider.id.trim() ? provider.id.trim().slice(0, 120) : 'provider-server');
    return resolvePreservedApiKey(provider, existing);
  });
  const embedding = patch.embedding
    ? resolvePreservedApiKey(patch.embedding, current.embedding)
    : null;
  return { ...patch, providers, embedding };
}

function resolvePreservedApiKey(provider, existing) {
  if (!existing?.apiKey) return provider;
  if (provider.apiKey === undefined || provider.apiKey.startsWith(MASK_PREFIX)) {
    return { ...provider, apiKey: existing.apiKey };
  }
  return provider;
}

function normalizeSettings(value) {
  if (!value || typeof value !== 'object') return { ...EMPTY, providers: [], embedding: null };
  const providers = (Array.isArray(value.providers) ? value.providers : [])
    .map(normalizeProvider)
    .filter(Boolean);
  return {
    providers,
    activeProviderId: providers.some((provider) => provider.id === value.activeProviderId)
      ? value.activeProviderId
      : providers[0]?.id ?? null,
    embedding: normalizeProvider(value.embedding, { nullable: true }),
  };
}

function normalizeProvider(value, { nullable = false } = {}) {
  if (!value || typeof value !== 'object') return nullable ? null : null;
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint.trim().slice(0, 500) : '';
  if (!endpoint) return nullable ? null : null;
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim().slice(0, 120) : 'provider-server',
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 80) : '未命名模型',
    service: typeof value.service === 'string' && value.service.trim() ? value.service.trim().slice(0, 80) : '自定义 (OpenAI Compatible)',
    endpoint,
    model: typeof value.model === 'string' ? value.model.trim().slice(0, 120) : '',
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.slice(0, 500) : '',
    authHeader: value.authHeader === 'x-api-key' ? 'x-api-key' : 'bearer',
    enabled: value.enabled !== false,
  };
}

/** 掩码值不是可用凭证：显式携带掩码 Key 的 provider（多来自配置回显）应回落服务端配置 */
export function isMaskedApiKey(apiKey) {
  return typeof apiKey === 'string' && apiKey.startsWith(MASK_PREFIX);
}

/** 供聊天/索引使用的对话模型配置：显式 provider 优先，否则取服务端激活项 */
export function resolveChatProvider(explicit) {
  if (explicit?.endpoint && explicit?.apiKey && !isMaskedApiKey(explicit.apiKey)) return explicit;
  const settings = loadServerSettings();
  const active = settings.providers.find((provider) => provider.id === settings.activeProviderId)
    ?? settings.providers[0]
    ?? null;
  return active?.enabled !== false && active?.endpoint && active?.apiKey ? active : null;
}

/** 供索引管道使用的 embedding 配置；未配置时返回 null（索引器据此跳过） */
export function resolveEmbeddingProvider() {
  const settings = loadServerSettings();
  const embedding = settings.embedding;
  return embedding?.endpoint && embedding?.apiKey && embedding?.model ? embedding : null;
}
