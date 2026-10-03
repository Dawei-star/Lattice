/**
 * 进程内有界后台任务运行器。
 *
 * 任务状态持久化到 SQLite，执行仍保持单进程，适合本地单用户场景。
 * 进程重启后 running 会恢复为 queued；具体任务通过 registerJobHandler 提供处理器。
 */
import { randomUUID } from 'node:crypto';
import { getDb, withTransaction } from '../db/index.js';
import { nowIso } from './time.js';
import { createLogger } from './logger.js';

const logger = createLogger({ app: 'lattice', scope: 'jobs' });
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** @type {Map<string, (payload: object, context: object) => Promise<object>|object>} */
const handlers = new Map();
const scheduled = new Set();
let drainTimer = null;
let draining = false;
let runnerStarted = false;

export function registerJobHandler(type, handler) {
  if (!type || typeof handler !== 'function') throw new TypeError('任务处理器必须包含 type 和 function');
  handlers.set(type, handler);
  scheduleDrain();
}

export function enqueueJob({ type, payload = {}, total = 0, idempotencyKey = null } = {}) {
  const existing = idempotencyKey
    ? getDb().prepare(
      'SELECT * FROM jobs WHERE type = ? AND idempotency_key = ? AND status IN (\'queued\', \'running\') ORDER BY created_at DESC LIMIT 1',
    ).get(type, idempotencyKey)
    : null;
  if (existing) return mapJob(existing);

  const timestamp = nowIso();
  const id = randomUUID();
  try {
    withTransaction(() => {
      getDb().prepare(
        `INSERT INTO jobs (
           id, type, status, progress, total, payload, idempotency_key,
           created_at, updated_at
         ) VALUES (?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
      ).run(id, type, Math.max(0, Number(total) || 0), JSON.stringify(payload ?? {}), idempotencyKey, timestamp, timestamp);
    });
  } catch (error) {
    // 两次相同的用户请求可能同时到达，唯一索引下返回已存在的活动任务。
    if (idempotencyKey) {
      const concurrent = getDb().prepare(
        'SELECT * FROM jobs WHERE type = ? AND idempotency_key = ? AND status IN (\'queued\', \'running\') ORDER BY created_at DESC LIMIT 1',
      ).get(type, idempotencyKey);
      if (concurrent) return mapJob(concurrent);
    }
    throw error;
  }

  scheduled.add(id);
  scheduleDrain();
  return getJob(id);
}

export function getJob(id) {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return row ? mapJob(row) : null;
}

export function listJobs({ type, status, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const clauses = [];
  const params = [];
  if (type) {
    clauses.push('type = ?');
    params.push(type);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, safeLimit).map(mapJob);
}

export function cancelJob(id) {
  const timestamp = nowIso();
  const result = getDb().prepare(
    `UPDATE jobs
        SET status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
            error = CASE WHEN status IN ('queued', 'running') THEN '用户取消' ELSE error END,
            finished_at = CASE WHEN status IN ('queued', 'running') THEN ? ELSE finished_at END,
            updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`,
  ).run(timestamp, timestamp, id);
  if (!result.changes) return getJob(id);
  scheduled.delete(id);
  scheduleDrain();
  return getJob(id);
}

/** 启动时恢复上次进程中断的任务，并继续处理队列。 */
export function recoverJobs() {
  runnerStarted = true;
  const timestamp = nowIso();
  getDb().prepare(
    `UPDATE jobs
        SET status = 'queued',
            error = CASE WHEN error IS NULL THEN '进程重启后恢复' ELSE error END,
            started_at = NULL,
            updated_at = ?
      WHERE status = 'running'`,
  ).run(timestamp);
  getDb().prepare('SELECT id FROM jobs WHERE status = \'queued\'').all().forEach((row) => scheduled.add(row.id));
  scheduleDrain();
}

function scheduleDrain() {
  if (!runnerStarted) return;
  if (drainTimer) return;
  drainTimer = setImmediate(() => {
    drainTimer = null;
    drain().catch((error) => logger.error('job_drain_failed', { err: error }));
  });
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const row = getDb().prepare(
        `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
      ).get();
      if (!row) break;

      const handler = handlers.get(row.type);
      if (!handler) {
        finishJob(row.id, 'failed', null, `没有注册任务处理器：${row.type}`);
        scheduled.delete(row.id);
        continue;
      }

      const startedAt = nowIso();
      // 带状态条件的「认领」更新：与 cancelJob 并发时抢不到就跳过，
      // 否则已取消的任务仍会被全量执行（长任务会白烧上游配额）
      const claim = getDb().prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`,
      ).run(startedAt, startedAt, row.id);
      scheduled.delete(row.id);
      if (!claim.changes) continue;

      const context = {
        jobId: row.id,
        update: (patch) => updateJob(row.id, patch),
        isCancelled: () => getDb().prepare('SELECT status FROM jobs WHERE id = ?').get(row.id)?.status === 'cancelled',
      };

      try {
        const result = await handler(parseJson(row.payload, {}), context);
        const current = getJob(row.id);
        if (current?.status === 'cancelled') {
          finishJob(row.id, 'cancelled', result, current.error ?? '用户取消');
        } else {
          finishJob(row.id, 'completed', result, null);
        }
      } catch (error) {
        const current = getJob(row.id);
        if (current?.status === 'cancelled') {
          finishJob(row.id, 'cancelled', null, current.error ?? '用户取消');
        } else {
          finishJob(row.id, 'failed', null, String(error?.message ?? '后台任务失败').slice(0, 1000));
        }
        logger.error('job_failed', { jobId: row.id, type: row.type, err: error });
      }
    }
  } finally {
    draining = false;
    if (scheduled.size) scheduleDrain();
  }
}

function updateJob(id, { progress, total, message } = {}) {
  const current = getJob(id);
  if (!current || TERMINAL_STATUSES.has(current.status)) return current;
  const nextProgress = progress === undefined ? current.progress : Math.max(0, Number(progress) || 0);
  const nextTotal = total === undefined ? current.total : Math.max(0, Number(total) || 0);
  getDb().prepare(
    `UPDATE jobs
        SET progress = ?, total = ?, message = COALESCE(?, message), updated_at = ?
      WHERE id = ? AND status = 'running'`,
  ).run(nextProgress, nextTotal, message ?? null, nowIso(), id);
  return getJob(id);
}

function finishJob(id, status, result, error) {
  const timestamp = nowIso();
  getDb().prepare(
    `UPDATE jobs
        SET status = ?, result = ?, error = ?, finished_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(status, result === null || result === undefined ? null : JSON.stringify(result), error, timestamp, timestamp, id);
}

function mapJob(row) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    total: row.total,
    message: row.message ?? null,
    payload: parseJson(row.payload, {}),
    result: parseJson(row.result, null),
    error: row.error ?? null,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    updatedAt: row.updated_at,
  };
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
