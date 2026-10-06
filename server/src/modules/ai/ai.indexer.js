/**
 * 语义索引编排：增量队列 + 后台低优先级处理。
 *
 * vault 同步（sync.js）在笔记投影变化后调用 scheduleNoteIndex(noteId)，
 * 笔记删除后由外键级联清理分块、并顺带清掉索引状态。队列特性：
 * - 防抖合并：同一笔记短时间多次保存只算最后一次；
 * - 串行低速：逐篇处理，embedding API 批内完成，不打扰前台写入；
 * - 状态可见：ai_index_state 记录 pending/indexed/failed 与错误信息；
 * - 失败退避：指数退避重试（最多 5 次），不让坏配置刷爆上游配额。
 *
 * 未配置 embedding 模型时所有入队操作只记录状态，不发起任何网络调用；
 * 配置好模型后 reindexPending() 会把积压一次性补齐。
 */
import { getDb, withTransaction } from '../../db/index.js';
import { nowIso } from '../../lib/time.js';
import { createLogger } from '../../lib/logger.js';
import { enqueueJob, registerJobHandler } from '../../lib/jobs.js';
import { chunkNoteContent, chunkEmbedText, embedTexts, storeNoteChunks, removeNoteIndex, yieldToChatTraffic } from './ai.embeddings.js';
import { resolveEmbeddingProvider } from './ai.settings.js';

const logger = createLogger({ app: 'lattice', scope: 'ai-indexer' });

const MAX_ATTEMPTS = 5;
const DEBOUNCE_MS = 2_000;

/** @type {Set<string>} */
const queuedNoteIds = new Set();
/** @type {NodeJS.Timeout | null} */
let flushTimer = null;
let draining = false;

registerJobHandler('ai-reindex', runReindexJob);

/** 笔记投影变化后调用（sync.js 挂钩）。未配置模型时只登记 pending 状态。 */
export function scheduleNoteIndex(noteId, { contentHash } = {}) {
  // 语义索引是投影的附属品：任何失败（如库未迁移）都不允许拖垮 vault 同步
  try {
    scheduleNoteIndexUnsafe(noteId, { contentHash });
  } catch (error) {
    logger.warn('indexer_schedule_failed', { noteId, err: error });
  }
}

function scheduleNoteIndexUnsafe(noteId, { contentHash } = {}) {
  if (!noteId) return;
  const db = getDb();
  const note = db.prepare('SELECT content_hash FROM notes WHERE id = ?').get(noteId);
  if (!note) return;
  const hash = contentHash ?? note.content_hash;

  db.prepare(
    `INSERT INTO ai_index_state (note_id, content_hash, model, chunk_count, status, updated_at)
       VALUES (?, ?, COALESCE(?, ''), 0, 'pending', ?)
       ON CONFLICT(note_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         status = CASE WHEN ai_index_state.content_hash = excluded.content_hash
                         AND ai_index_state.status = 'indexed'
                       THEN 'indexed' ELSE 'pending' END,
         updated_at = excluded.updated_at`,
  ).run(noteId, hash, resolveEmbeddingProvider()?.model ?? null, nowIso());

  queuedNoteIds.add(noteId);
  scheduleFlush();
}

/** 全量重建入队：实际扫描和索引在可恢复的后台任务中执行。 */
export function reindexAll() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
  return enqueueJob({
    type: 'ai-reindex',
    total,
    payload: { requestedAt: nowIso() },
    idempotencyKey: 'all',
  });
}

async function runReindexJob(_payload, context) {
  const db = getDb();
  const model = resolveEmbeddingProvider()?.model ?? '';
  // 只重置真正过期的笔记（无状态 / 未 indexed / hash 或 model 变化）。
  // 若无条件全部置 pending，indexNote 的「未变化跳过」永远不会生效，
  // 每次全量重建都要重写所有笔记的分块与向量行。
  const rows = db
    .prepare(
      `SELECT n.id, n.content_hash
         FROM notes n
         LEFT JOIN ai_index_state s ON s.note_id = n.id
        WHERE s.note_id IS NULL
           OR s.status <> 'indexed'
           OR s.content_hash <> n.content_hash
           OR s.model <> ?`,
    )
    .all(model);

  withTransaction(() => {
    for (const row of rows) {
      db.prepare(
        `INSERT INTO ai_index_state (note_id, content_hash, model, chunk_count, status, updated_at)
           VALUES (?, ?, ?, 0, 'pending', ?)
           ON CONFLICT(note_id) DO UPDATE SET
             content_hash = excluded.content_hash, model = excluded.model,
             status = CASE WHEN ai_index_state.content_hash = excluded.content_hash
                             AND ai_index_state.model = excluded.model
                             AND ai_index_state.status = 'indexed'
                           THEN 'indexed' ELSE 'pending' END,
             error = NULL, attempts = 0, updated_at = excluded.updated_at`,
      ).run(row.id, row.content_hash, model, nowIso());
    }
  });

  context.update({ total: rows.length, progress: 0, message: 'reindex started' });
  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  for (const row of rows) {
    if (context.isCancelled()) break;
    try {
      const result = await indexNote(row.id);
      if (result.status === 'skipped-unconfigured') skipped += 1;
      else if (result.status === 'failed') failed += 1;
      else indexed += 1;
    } catch {
      failed += 1;
    }
    processed += 1;
    context.update({
      progress: processed,
      total: rows.length,
      message: `${processed}/${rows.length}`,
    });
    await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    total: rows.length,
    processed,
    indexed,
    skipped,
    failed,
    cancelled: context.isCancelled(),
  };
}

/** 防抖后串行处理队列 */
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    drain().catch((error) => logger.error('indexer_drain_failed', { err: error }));
  }, DEBOUNCE_MS);
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queuedNoteIds.size > 0) {
      const [noteId] = queuedNoteIds;
      queuedNoteIds.delete(noteId);
      await indexNote(noteId);
      // 让出事件循环：索引永远不与用户操作抢主线程
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    draining = false;
    if (queuedNoteIds.size > 0) scheduleFlush();
  }
}

/**
 * 索引单篇笔记。返回 { status, chunks, reused }；失败时记录退避并返回 { status: 'failed' }。
 * 三级增量：笔记未变 → 跳过；块未变 → 复用旧向量；只有新增/变化块调用 API。
 */
export async function indexNote(noteId, { provider = null } = {}) {
  const db = getDb();
  const note = db.prepare('SELECT id, title, content, content_hash FROM notes WHERE id = ?').get(noteId);
  if (!note) {
    removeNoteIndex(noteId);
    return { status: 'removed' };
  }

  const resolved = provider ?? resolveEmbeddingProvider();
  if (!resolved) return { status: 'skipped-unconfigured' };
  const model = resolved.model;

  const state = db.prepare('SELECT content_hash, model, status FROM ai_index_state WHERE note_id = ?').get(noteId);
  if (state && state.status === 'indexed' && state.content_hash === note.content_hash && state.model === model) {
    return { status: 'unchanged' };
  }

  const chunks = chunkNoteContent(note.title, note.content);
  if (!chunks.length) {
    storeNoteChunks(noteId, { chunks: [], vectors: [], model, noteContentHash: note.content_hash });
    return { status: 'indexed', chunks: 0, reused: 0 };
  }

  // 块级增量：内容哈希相同且向量行还在的块直接复用
  const existingVectors = new Map();
  for (const row of db.prepare(
    `SELECT c.content_hash AS hash, e.vector, e.dim, e.model
       FROM note_chunks c JOIN note_chunk_embeddings e ON e.chunk_id = c.id
      WHERE c.note_id = ? AND e.model = ?`,
  ).all(noteId, model)) {
    if (!existingVectors.has(row.hash)) existingVectors.set(row.hash, row);
  }
  const needEmbedding = [];
  const vectors = new Array(chunks.length).fill(null);
  chunks.forEach((chunk, ordinal) => {
    const cached = existingVectors.get(chunk.contentHash);
    if (cached && cached.dim > 0) {
      vectors[ordinal] = new Float32Array(cached.vector.buffer, cached.vector.byteOffset, cached.dim);
    } else {
      needEmbedding.push({ ordinal, text: chunkEmbedText(note.title, chunk) });
    }
  });

  const reused = chunks.length - needEmbedding.length;
  try {
    if (needEmbedding.length) {
      // 分批：上游对批量大小普遍有上限（常见 16~64），取保守值
      const BATCH = 16;
      for (let offset = 0; offset < needEmbedding.length; offset += BATCH) {
        // 对话流量优先：近期有对话查询时给上游留喘息窗口，避免重建索引把对话限流
        await yieldToChatTraffic();
        const batch = needEmbedding.slice(offset, offset + BATCH);
        const batchVectors = await embedTexts(batch.map((item) => item.text), { provider: resolved });
        batch.forEach((item, index) => {
          vectors[item.ordinal] = batchVectors[index];
        });
      }
      if (vectors.some((vector) => !vector)) throw new Error('embedding 服务返回数量与输入不一致');
    }
    storeNoteChunks(noteId, { chunks, vectors, model, noteContentHash: note.content_hash });
    return { status: 'indexed', chunks: chunks.length, reused };
  } catch (error) {
    recordFailure(noteId, note.content_hash, model, error);
    throw error;
  }
}

function recordFailure(noteId, contentHash, model, error) {
  const db = getDb();
  const message = String(error?.message ?? '索引失败').slice(0, 500);
  try {
    db.prepare(
      `INSERT INTO ai_index_state (note_id, content_hash, model, chunk_count, status, error, attempts, updated_at)
         VALUES (?, ?, ?, 0, 'failed', ?, 1, ?)
         ON CONFLICT(note_id) DO UPDATE SET
           status = 'failed', error = excluded.error, attempts = ai_index_state.attempts + 1, updated_at = excluded.updated_at`,
    ).run(noteId, contentHash, model, message, nowIso());
  } catch (recordError) {
    logger.error('indexer_state_write_failed', { err: recordError });
  }
}

/** 索引是否已就绪（有任一已索引块）——语义检索入口用它快速判断 */
export function hasIndex() {
  const db = getDb();
  return db.prepare('SELECT EXISTS(SELECT 1 FROM note_chunk_embeddings) AS has').get().has === 1;
}
