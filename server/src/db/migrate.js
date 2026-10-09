/**
 * 迁移执行器。
 * - 按文件名排序依次应用 src/migrations/*.sql
 * - 每个迁移在独立事务中执行，失败即整体回滚，不留半成品
 * - 记录 sha256 校验和，已应用迁移被篡改时直接报错（漂移检测）
 *
 * 用法：
 *   编程式：import { runMigrations } from './migrate.js'; runMigrations();
 *   命令行：npm run db:migrate
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, closeDatabase, getDb } from './index.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger({ app: 'lattice', scope: 'migrate' });

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Git and release tooling may materialize SQL files with different newline
 * styles. Newlines are formatting, so they must not change a migration's
 * identity or invalidate an already-applied migration on Windows.
 */
export function normalizeMigrationSql(sql) {
  return sql.replace(/\r\n?/g, '\n');
}

export function migrationChecksum(sql) {
  return createHash('sha256').update(normalizeMigrationSql(sql), 'utf8').digest('hex');
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function readMigrationFiles() {
  if (!fs.existsSync(migrationsDir)) return [];

  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
      return {
        version: name.replace(/\.sql$/, ''),
        sql,
        checksum: migrationChecksum(sql),
      };
    });
}

/**
 * @returns {{ applied: string[], skipped: number }}
 */
export function runMigrations() {
  openDatabase();
  const db = getDb();
  ensureMigrationsTable(db);

  const appliedRows = db.prepare('SELECT version, checksum FROM schema_migrations').all();
  /** @type {Map<string, string>} */
  const appliedMap = new Map(appliedRows.map((row) => [row.version, row.checksum]));

  const files = readMigrationFiles();
  const applied = [];

  for (const file of files) {
    const previousChecksum = appliedMap.get(file.version);

    if (previousChecksum) {
      if (previousChecksum !== file.checksum) {
        throw new Error(
          `迁移 ${file.version} 的内容在应用后被修改（校验和不一致）。请新增一个迁移文件，而不是改动历史迁移。`,
        );
      }
      continue;
    }

    // SQLite 支持事务化 DDL，迁移失败可以完整回滚
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(file.sql);
      db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(
        file.version,
        file.checksum,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${file.version} 执行失败：${error.message}`, { cause: error });
    }

    applied.push(file.version);
    logger.info('migration_applied', { version: file.version });
  }

  return { applied, skipped: files.length - applied.length };
}

/** 直接作为脚本运行时的入口 */
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    const { applied, skipped } = runMigrations();
    if (applied.length === 0) {
      logger.info('database_up_to_date', { skipped });
      console.log(`数据库已是最新，跳过 ${skipped} 个已应用的迁移。`);
    } else {
      console.log(`已应用 ${applied.length} 个迁移：${applied.join(', ')}`);
    }
    closeDatabase();
  } catch (error) {
    logger.error('migration_failed', { err: error });
    console.error(`迁移失败：${error.message}`);
    closeDatabase();
    process.exit(1);
  }
}
