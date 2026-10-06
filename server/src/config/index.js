/**
 * 集中式配置：所有环境变量在此解析并在启动时校验。
 * 任何非法或缺失的必填项都会立即抛出，让进程快速失败（fail fast），
 * 而不是在运行到某个请求时才暴露问题。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** server/ 目录的绝对路径 */
export const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(5177),
    DB_FILE: z.string().min(1).default('./data/lattice.db'),
    VAULT_DIR: z.string().min(1).optional(),
    CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    AUTO_MIGRATE: booleanish.default('true'),
    WORKSPACE_ACCESS_TOKEN: z.string().min(16).max(500).optional(),
    WORKSPACE_ACCESS_ROLE: z.enum(['viewer', 'editor', 'admin']).default('editor'),
    AI_ACCESS_TOKEN: z.string().min(16).max(500).optional(),
    AI_ACCESS_ROLE: z.enum(['viewer', 'editor', 'admin']).default('editor'),
    AI_SETTINGS_ENCRYPTION_KEY: z.string().min(43).max(128).optional(),
    // 聊天类上游调用的超时：推理型模型生成完整回复可能需要 1-2 分钟，
    // 连通性测试仍固定 20 秒（探针只请求 max_tokens=1，慢说明不可用）
    AI_CHAT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
    // 前端构建产物目录覆盖。桌面端打包后前端不在仓库相对位置上，
    // 需要显式指向 resources 下的解包目录；留空则回退到 web/dist 约定路径。
    WEB_DIST_DIR: z.string().min(1).optional(),
    // 每日摘要自动生成时刻（本地时区 0-23 点）。留空 = 不定时，仅手动触发
    AI_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).optional(),
    // 默认拒绝指向内网/回环地址的 AI endpoint（SSRF 防护）。
    // 自建本地模型（Ollama 等）的用户可显式开启；test 环境始终放行（mock 上游在 127.0.0.1）。
    AI_ALLOW_PRIVATE_ENDPOINTS: booleanish.default('false'),
    // 向量常驻内存缓存：检索免去每次全表 BLOB 读取与重复反序列化；索引写入会自动失效。off 回退旧行为
    AI_VECTOR_CACHE: booleanish.default('true'),
    // 上游 429/5xx/建连失败自动重试次数（流式首包之后不重试）；0 = 关闭
    AI_RETRY_MAX: z.coerce.number().int().min(0).max(3).default(1),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production' && value.CORS_ORIGINS.split(',').some((o) => o.trim() === '*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: '生产环境禁止使用通配符来源 *，请显式列出允许的前端域名',
      });
    }
    // All /api endpoints must have a workspace boundary when listening beyond loopback.
    const loopback = ['127.0.0.1', '::1', 'localhost'];
    if (!loopback.includes(value.HOST) && !value.WORKSPACE_ACCESS_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HOST'],
        message: `HOST=${value.HOST} requires WORKSPACE_ACCESS_TOKEN (>=16 chars) to protect the workspace API`,
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  console.error(`配置校验失败，进程终止：\n${lines.join('\n')}\n\n请检查 server/.env（可参考 server/.env.example）`);
  process.exit(1);
}

const env = parsed.data;

const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

/** 冻结的运行时配置，业务代码只读 */
export const config = Object.freeze({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  host: env.HOST,
  port: env.PORT,
  dbFile: path.isAbsolute(env.DB_FILE) ? env.DB_FILE : path.join(serverRoot, env.DB_FILE),
  vaultDir: env.VAULT_DIR
    ? path.isAbsolute(env.VAULT_DIR)
      ? path.normalize(env.VAULT_DIR)
      : path.resolve(process.cwd(), env.VAULT_DIR)
    : path.join(path.isAbsolute(env.DB_FILE) ? path.dirname(env.DB_FILE) : path.join(serverRoot, path.dirname(env.DB_FILE)), 'vault'),
  corsOrigins: Object.freeze(corsOrigins),
  logLevel: env.LOG_LEVEL,
  autoMigrate: env.AUTO_MIGRATE,
  workspaceAccessToken: env.WORKSPACE_ACCESS_TOKEN ?? '',
  workspaceAccessRole: env.WORKSPACE_ACCESS_ROLE,
  aiAccessToken: env.AI_ACCESS_TOKEN ?? '',
  aiAccessRole: env.AI_ACCESS_ROLE,
  aiSettingsEncryptionKey: env.AI_SETTINGS_ENCRYPTION_KEY ?? '',
  aiChatTimeoutMs: env.AI_CHAT_TIMEOUT_MS,
  /** 向量常驻内存缓存开关（索引写入自动失效；off 回退全表扫描） */
  aiVectorCache: env.AI_VECTOR_CACHE,
  /** 上游瞬时失败自动重试次数（流式首包后失效） */
  aiRetryMax: env.AI_RETRY_MAX,
  /** 前端构建产物目录，存在时由后端一并托管（单进程生产模式） */
  webDistDir: env.WEB_DIST_DIR
    ? path.resolve(env.WEB_DIST_DIR)
    : path.join(serverRoot, '..', 'web', 'dist'),
  /** 每日摘要自动生成时刻；未设置则不启用定时 */
  aiDigestHour: env.AI_DIGEST_HOUR ?? null,
  /** 是否允许 AI endpoint 指向内网/回环地址；测试运行时恒为 true（mock 上游在回环） */
  aiAllowPrivateEndpoints:
    env.AI_ALLOW_PRIVATE_ENDPOINTS || env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT !== undefined,
});
