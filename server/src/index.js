/**
 * 进程入口：初始化数据库 → 执行迁移 → 启动 HTTP → 注册优雅停机。
 */
import { createApp } from './app.js';
import { config } from './config/index.js';
import { closeDatabase, openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { maybeRunScheduledDigest } from './modules/ai/ai.digest.js';
import { logger } from './lib/logger.js';
import { recoverJobs } from './lib/jobs.js';
import { resolveVaultDir } from './vault/config.js';
import { publishVaultEvent } from './vault/events.js';
import { VaultAdapter } from './vault/vault.adapter.js';
import { reconcileVault } from './vault/sync.js';
import { watchVault } from './vault/watcher.js';

let stopVaultWatcher = null;

async function bootstrap() {
  openDatabase();
  logger.info('database_opened', { file: config.dbFile });

  if (config.autoMigrate) {
    const { applied } = runMigrations();
    logger.info('migrations_checked', { newlyApplied: applied.length });
  }
  recoverJobs();

  await syncMarkdownVault();
  stopVaultWatcher = watchVault(resolveVaultDir(config.vaultDir), {
    log: (event) => logger.info('markdown_vault_changed', event),
    onChange: publishVaultEvent,
  });

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info('server_started', {
      url: `http://${config.host}:${config.port}`,
      env: config.env,
      corsOrigins: config.corsOrigins,
    });
  });

  server.on('error', (error) => {
    logger.error('server_error', { err: error });
    process.exit(1);
  });

  startDigestScheduler();
  installShutdownHandlers(server);
}

/** 每日摘要定时器：配置了 AI_DIGEST_HOUR 时每小时检查一次，到点且当天未生成则自动生成 */
function startDigestScheduler() {
  if (config.aiDigestHour === null || config.aiDigestHour === undefined) return;
  const timer = setInterval(async () => {
    try {
      const result = await maybeRunScheduledDigest();
      if (result) logger.info('digest_generated', { noteId: result.noteId, modifiedCount: result.modifiedCount });
    } catch (error) {
      logger.error('digest_scheduler_failed', { err: error });
    }
  }, 60 * 60 * 1000);
  timer.unref();
  // 启动时也检查一次（服务器在配置时刻之后才启动的场景）
  maybeRunScheduledDigest().then((result) => {
    if (result) logger.info('digest_generated_on_boot', { noteId: result.noteId });
  }).catch((error) => logger.error('digest_scheduler_failed', { err: error }));
  logger.info('digest_scheduler_started', { hour: config.aiDigestHour });
}

async function syncMarkdownVault() {
  const vaultDir = resolveVaultDir(config.vaultDir);
  const vault = new VaultAdapter(vaultDir);
  try {
    // full 模式：逐文件比对 content_hash，未变化的文件零写库。
    // 首次运行会为存量投影回填哈希，之后的启动只读文件、几乎不写。
    const result = await reconcileVault(vault, { mode: 'full' });
    logger.info('markdown_vault_indexed', { vaultDir, ...result });
  } catch (error) {
    logger.error('markdown_vault_index_failed', { vaultDir, err: error });
    throw error;
  }
}

function installShutdownHandlers(server) {
  let closing = false;

  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    logger.info('shutdown_started', { signal });

    // 停止接收新连接，等在途请求处理完
    server.close((error) => {
      if (error) logger.error('shutdown_server_error', { err: error });
      else logger.info('shutdown_server_closed');

      try {
        stopVaultWatcher?.();
        stopVaultWatcher = null;
        closeDatabase();
        logger.info('shutdown_database_closed');
      } catch (dbError) {
        logger.error('shutdown_database_error', { err: dbError });
      }
      process.exit(error ? 1 : 0);
    });

    // 兜底：10 秒内没关干净就强制退出，避免僵死进程
    setTimeout(() => {
      logger.warn('shutdown_forced', { reason: 'timeout' });
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.error('uncaught_exception', { err: error });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
  });
}

bootstrap();
