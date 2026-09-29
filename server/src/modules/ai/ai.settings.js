/**
 * 服务端 AI 配置存储（SQLite ai_settings 表）。
 *
 * 此前模型配置只存浏览器 localStorage：换端失忆、CLI 拿不到配置、
 * 服务端 embedding 索引管道更是无从谈起。现在配置落地服务端，
 * 聊天 / 索引 / CLI 共用同一份；浏览器端通过 PUT 同步、GET 读取。
 *
 * 信任边界：单机本地应用，Key 与 SQLite 同盘存放，等同于数据库文件本身的安全边界。
 */
import { getDb } from '../../db/index.js';
import { nowIso } from '../../lib/time.js';

const SETTINGS_KEY = 'model-config';

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
    return normalizeSettings(JSON.parse(row.value));
  } catch {
    return EMPTY_RESULT();
  }
}

/** 全量覆盖写入。调用方负责校验结构（路由层 zod）。 */
export function saveServerSettings(patch) {
  const db = getDb();
  const next = normalizeSettings(patch);
  db.prepare(
    'INSERT INTO ai_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(SETTINGS_KEY, JSON.stringify(next), nowIso());
  return next;
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

/** 供聊天/索引使用的对话模型配置：显式 provider 优先，否则取服务端激活项 */
export function resolveChatProvider(explicit) {
  if (explicit?.endpoint && explicit?.apiKey) return explicit;
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
