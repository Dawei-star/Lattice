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
    CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    AUTO_MIGRATE: booleanish.default('true'),
    // 附件（图片/文件）落盘目录。留空则回退到数据库同级的 data/attachments，
    // 这样桌面版把整个数据目录拷走即可带走全部附件。
    ATTACHMENTS_DIR: z.string().min(1).optional(),
    // 单个附件上传体积上限（MB）。base64 会让 JSON body 放大约 4/3，
    // 请求体总上限据此推导，见下方 maxBodyBytes。
    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(15),
    // 前端构建产物目录覆盖。桌面端打包后前端不在仓库相对位置上，
    // 需要显式指向 resources 下的解包目录；留空则回退到 web/dist 约定路径。
    WEB_DIST_DIR: z.string().min(1).optional(),
    // 静态站点导出的落盘根目录。留空则回退到数据库同级的 data/export。
    // 每次导出在其下建一个时间戳子目录，整体拷走即可发布，互不覆盖。
    EXPORT_DIR: z.string().min(1).optional(),
    // 版本历史快照的最小时间间隔（分钟）：距上一条快照超过它才再存一条，
    // 用以抑制自动保存（900ms）造成的历史刷屏。设 0 表示每次实质改动都存。
    VERSION_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(5),
    // 每篇笔记保留的最大版本数，超出按时间淘汰最旧的。
    VERSION_RETENTION: z.coerce.number().int().min(1).max(1000).default(50),
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
  corsOrigins: Object.freeze(corsOrigins),
  logLevel: env.LOG_LEVEL,
  autoMigrate: env.AUTO_MIGRATE,
  /** 附件落盘目录，默认与数据库文件同级（data/attachments），整体拷走即带走全部附件 */
  attachmentsDir: env.ATTACHMENTS_DIR
    ? path.resolve(env.ATTACHMENTS_DIR)
    : path.join(path.dirname(path.isAbsolute(env.DB_FILE) ? env.DB_FILE : path.join(serverRoot, env.DB_FILE)), 'attachments'),
  /** 静态站点导出根目录，默认与数据库同级（data/export）；每次导出在其下建时间戳子目录 */
  exportDir: env.EXPORT_DIR
    ? path.resolve(env.EXPORT_DIR)
    : path.join(path.dirname(path.isAbsolute(env.DB_FILE) ? env.DB_FILE : path.join(serverRoot, env.DB_FILE)), 'export'),
  /** 版本快照最小间隔（毫秒）与每篇笔记保留上限 */
  versionIntervalMs: env.VERSION_INTERVAL_MINUTES * 60 * 1000,
  versionRetention: env.VERSION_RETENTION,
  maxUploadMb: env.MAX_UPLOAD_MB,
  /** base64 上传使 JSON body 约为原文件的 4/3，再加转义余量后推导出请求体上限 */
  maxBodyBytes: Math.ceil(env.MAX_UPLOAD_MB * 1024 * 1024 * (4 / 3)) + 64 * 1024,
  /** 前端构建产物目录，存在时由后端一并托管（单进程生产模式） */
  webDistDir: env.WEB_DIST_DIR
    ? path.resolve(env.WEB_DIST_DIR)
    : path.join(serverRoot, '..', 'web', 'dist'),
});
