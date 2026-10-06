/**
 * 进程入口：初始化数据库 → 执行迁移 → 启动 HTTP → 注册优雅停机。
 */
import { createApp } from './app.js';
import { config } from './config/index.js';
import { closeDatabase, openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { maybeRunScheduledDigest } from './modules/ai/ai.digest.js';
import { warnIfPlaintextKeys } from './modules/ai/ai.settings.js';
import { closeAllMcpConnections } from './modules/ai/ai.mcp.js';
import { logger } from './lib/logger.js';
import { recoverJobs } from './lib/jobs.js';
import { resolveVaultDir } from './vault/config.js';
import { closeVaultEventClients, publishVaultEvent } from './vault/events.js';
import { registerWatcherControl } from './vault/watcher-control.js';
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
  warnIfPlaintextKeys(logger);

  await syncMarkdownVault();
  const watcherHandle = watchVault(resolveVaultDir(config.vaultDir), {
    log: (event) => logger.info('markdown_vault_changed', event),
    onChange: publishVaultEvent,
  });
  registerWatcherControl(watcherHandle);
  stopVaultWatcher = () => {
    registerWatcherControl(null);
    watcherHandle();
  };

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

    // 先关掉 SSE 长连接，否则 server.close 会一直等在途请求、吃满 10 秒兜底
    closeVaultEventClients();

    // 用户配置的 MCP Server 是这里拉起的子进程：不显式关闭的话，它们只能靠
    // 「管道断开后对方自觉退出」，感知不到 stdin 结束的就成了孤儿进程
    void closeAllMcpConnections().catch((error) => {
      logger.warn('shutdown_mcp_close_error', { err: error });
    });

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

// 启动失败必须退出进程：否则 unhandledRejection 处理器只记日志，
// 服务未启动的「僵尸进程」会一直挂着（如 DB 打不开、vault sync 失败）。
bootstrap().catch((error) => {
  logger.error('bootstrap_failed', { err: error instanceof Error ? error : new Error(String(error)) });
  process.exit(1);
});
