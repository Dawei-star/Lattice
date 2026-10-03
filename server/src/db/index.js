/**
 * SQLite 连接管理。
 * 使用 Node 内置的 node:sqlite，因此本项目在数据库层没有任何原生依赖，
 * 不需要在 Windows 上编译 better-sqlite3 之类的模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config/index.js';

/** @type {DatabaseSync | null} */
let instance = null;

/**
 * 打开（或复用）数据库连接，并施加统一的连接级 PRAGMA。
 * @param {string} [file] 数据库文件路径，默认取配置
 * @returns {DatabaseSync}
 */
export function openDatabase(file = config.dbFile) {
  if (instance) return instance;

  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);

  // WAL：读写不互相阻塞，本地单机场景下明显更顺滑
  db.exec('PRAGMA journal_mode = WAL');
  // 外键约束默认关闭，必须显式打开，否则 ON DELETE CASCADE 全部失效
  db.exec('PRAGMA foreign_keys = ON');
  // NORMAL 在 WAL 下兼顾安全与性能
  db.exec('PRAGMA synchronous = NORMAL');
  // 写入被占用时最多等待 5s，避免直接抛 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000');

  instance = db;
  return db;
}

export function getDb() {
  if (!instance) {
    throw new Error('数据库尚未初始化，请先调用 openDatabase()');
  }
  return instance;
}

export function closeDatabase() {
  if (!instance) return;
  try {
    instance.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // checkpoint 失败不应阻止关闭流程
  }
  instance.close();
  instance = null;
}

/**
 * 事务包装器。支持嵌套调用（内层自动降级为 SAVEPOINT），
 * 因此服务层可以安全地互相组合而不必关心调用层级。
 * @template T
 * @param {(db: DatabaseSync) => T} fn
 * @returns {T}
 */
let depth = 0;
export function withTransaction(fn) {
  const db = getDb();
  const isOutermost = depth === 0;
  const savepoint = `sp_${depth}`;

  db.exec(isOutermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  depth += 1;

  try {
    const result = fn(db);
    depth -= 1;
    db.exec(isOutermost ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    depth -= 1;
    try {
      if (isOutermost) {
        db.exec('ROLLBACK');
      } else {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      }
    } catch {
      // 回滚本身失败时保留原始异常，交给上层记录
    }
    throw error;
  }
}
