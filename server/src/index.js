/**
 * 进程入口：初始化数据库 → 执行迁移 → 启动 HTTP → 注册优雅停机。
 */
import { createApp } from './app.js';
import { config } from './config/index.js';
import { closeDatabase, openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './lib/logger.js';

function bootstrap() {
  openDatabase();
  logger.info('database_opened', { file: config.dbFile });

  if (config.autoMigrate) {
    const { applied } = runMigrations();
    logger.info('migrations_checked', { newlyApplied: applied.length });
  }

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

  installShutdownHandlers(server);
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
