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
    AI_ACCESS_TOKEN: z.string().min(16).max(500).optional(),
    AI_ACCESS_ROLE: z.enum(['viewer', 'editor', 'admin']).default('editor'),
    // 前端构建产物目录覆盖。桌面端打包后前端不在仓库相对位置上，
    // 需要显式指向 resources 下的解包目录；留空则回退到 web/dist 约定路径。
    WEB_DIST_DIR: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production' && value.CORS_ORIGINS.split(',').some((o) => o.trim() === '*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: '生产环境禁止使用通配符来源 *，请显式列出允许的前端域名',
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
  aiAccessToken: env.AI_ACCESS_TOKEN ?? '',
  aiAccessRole: env.AI_ACCESS_ROLE,
  /** 前端构建产物目录，存在时由后端一并托管（单进程生产模式） */
  webDistDir: env.WEB_DIST_DIR
    ? path.resolve(env.WEB_DIST_DIR)
    : path.join(serverRoot, '..', 'web', 'dist'),
});
