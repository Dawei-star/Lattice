/**
 * 语义索引：笔记分块、embedding 存储、向量检索。
 *
 * 设计约束（延续项目「零原生依赖」底线）：
 * - 向量以 Float32Array 序列化 BLOB 存 node:sqlite，检索用 JS 暴力余弦；
 *   个人库规模（10^4~10^5 分块）单次查询毫秒级，够用且可预测。
 * - 分块按标题层级切（与 [[标题#小节]] 锚点体系一致），块过大再按段落二分。
 * - 增量策略：笔记 content_hash + embedding 模型 未变则整篇跳过；
 *   分块 content_hash 未变则只复用旧向量，不重复调用 embedding API。
 */
import { randomUUID } from 'node:crypto';
import { getDb, withTransaction } from '../../db/index.js';
import { config } from '../../config/index.js';
import { nowIso } from '../../lib/time.js';
import { callEmbeddingProvider } from './ai.provider.js';
import { resolveEmbeddingProvider } from './ai.settings.js';

// 分块参数：目标 600 字符、上限 900（中文场景按字符算），块间不加重叠——
// 标题锚点路径已把上下文带进每块，重叠对笔记语料收益有限、成本翻倍。
export const CHUNK_TARGET_CHARS = 600;
export const CHUNK_MAX_CHARS = 900;

// ── 分块 ─────────────────────────────────────────────────────────────

/**
 * 把笔记正文按标题层级切块。
 * @returns {Array<{ anchor: string, content: string, contentHash: string }>}
 */
export function chunkNoteContent(title, content) {
  const blocks = splitByHeadings(String(content ?? ''));
  const chunks = [];
  for (const block of blocks) {
    for (const piece of splitOversize(block.content)) {
      const text = piece.trim();
      if (!text) continue;
      chunks.push({
        anchor: block.anchor,
        content: text,
        contentHash: hashText(text),
      });
    }
  }
  if (!chunks.length) {
    const fallback = `${String(title ?? '').trim()} ${String(content ?? '').trim()}`.trim();
    if (fallback) {
      chunks.push({ anchor: '', content: fallback.slice(0, CHUNK_MAX_CHARS), contentHash: hashText(fallback.slice(0, CHUNK_MAX_CHARS)) });
    }
  }
  return chunks;
}

/** 组装喂给 embedding 模型的文本：标题 + 锚点路径 + 正文，让短块也携带上下文 */
export function chunkEmbedText(noteTitle, chunk) {
  const heading = chunk.anchor ? ` # ${chunk.anchor}` : '';
  return `${noteTitle}${heading}\n\n${chunk.content}`.slice(0, 4000);
}

/** 按标题行切块；每个块携带「文档标题 > 最近各级标题」的锚点路径 */
function splitByHeadings(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let anchorParts = [];
  let buffer = [];

  const flush = () => {
    if (buffer.some((line) => line.trim())) {
      blocks.push({ anchor: anchorParts.join(' > '), content: buffer.join('\n') });
    }
    buffer = [];
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      anchorParts = anchorParts.slice(0, level - 1);
      anchorParts[level - 1] = heading[2].trim();
      buffer.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return blocks.length ? blocks : [{ anchor: '', content }];
}

/** 超长块按段落（空行）二分到目标大小 */
function splitOversize(text) {
  const trimmed = text.trim();
  if (trimmed.length <= CHUNK_MAX_CHARS) return [trimmed];

  const paragraphs = trimmed.split(/\n\s*\n/);
  const pieces = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_MAX_CHARS) {
      if (current.trim()) pieces.push(current.trim());
      // 单段落仍超长：按行硬切
      for (let offset = 0; offset < paragraph.length; offset += CHUNK_TARGET_CHARS) {
        pieces.push(paragraph.slice(offset, offset + CHUNK_TARGET_CHARS));
      }
      current = '';
      continue;
    }
    if ((current + '\n\n' + paragraph).length > CHUNK_TARGET_CHARS && current.trim()) {
      pieces.push(current.trim());
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function hashText(text) {
  // FNV-1a 32 位足够做「分块内容是否变化」的快速比对（完整 sha256 在文件层已有）
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ── 向量写入与检索 ───────────────────────────────────────────────────

function packVector(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function unpackVector(blob) {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

// ── 向量内存缓存 ─────────────────────────────────────────────────────
// 每次检索都全表读 BLOB + 反序列化是检索段最大开销（1 万分块 ≈ 40MB/查询）。
// 缓存已反序列化的 Float32Array，按 indexVersion 失效：本模块的两个写入口
// （storeNoteChunks / removeNoteIndex）都会递增版本。超大库超出内存预算时
// 不缓存、回退逐查询加载，行为与旧版完全一致。
const VECTOR_CACHE_MAX_BYTES = 256 * 1024 * 1024;
let indexVersion = 0;
const vectorCache = new Map(); // model → { version, entries, bytes }

function loadVectorEntries(model) {
  const useCache = config.aiVectorCache;
  if (useCache) {
    const cached = vectorCache.get(model);
    if (cached && cached.version === indexVersion) return cached.entries;
  }
  const rows = getDb()
    .prepare(
      `SELECT e.chunk_id, e.vector, e.dim, c.note_id, c.anchor, c.content
         FROM note_chunk_embeddings e
         JOIN note_chunks c ON c.id = e.chunk_id
        WHERE e.model = ?`,
    )
    .all(model);
  let bytes = 0;
  const entries = rows.map((row) => {
    const vector = unpackVector(row.vector);
    bytes += vector.byteLength;
    return { chunkId: row.chunk_id, noteId: row.note_id, anchor: row.anchor, content: row.content, dim: row.dim, vector };
  });
  if (useCache) {
    if (bytes <= VECTOR_CACHE_MAX_BYTES) vectorCache.set(model, { version: indexVersion, entries, bytes });
    else vectorCache.delete(model);
  }
  return entries;
}

export function cosineSimilarity(a, b) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator ? dot / denominator : 0;
}

/**
 * 把一篇笔记的分块与向量写入投影。向量数必须与分块数一致。
 * 供索引器在全量重算后一次性写入；内容未变的块会沿用旧向量（先捕获再重写，
 * 因为 DELETE 分块会级联删除向量行）。
 */
export function storeNoteChunks(noteId, { chunks, vectors = null, model, noteContentHash }) {
  return withTransaction(() => {
    const db = getDb();
    // 先捕获现有分块的向量（按内容哈希索引），删除级联前留档
    const captured = new Map();
    for (const row of db.prepare(
      `SELECT c.content_hash AS hash, e.model, e.dim, e.vector
         FROM note_chunks c JOIN note_chunk_embeddings e ON e.chunk_id = c.id
        WHERE c.note_id = ?`,
    ).all(noteId)) {
      if (!captured.has(row.hash)) captured.set(row.hash, row);
    }

    db.prepare('DELETE FROM note_chunks WHERE note_id = ?').run(noteId);
    chunks.forEach((chunk, ordinal) => {
      const chunkId = randomUUID();
      db.prepare(
        `INSERT INTO note_chunks (id, note_id, ordinal, anchor, content, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(chunkId, noteId, ordinal, chunk.anchor, chunk.content, chunk.contentHash, nowIso(), nowIso());

      const fresh = vectors?.[ordinal] ?? null;
      const reused = !fresh && model ? captured.get(chunk.contentHash) : null;
      const vectorRow = fresh
        ? { model, dim: fresh.length, vector: packVector(fresh) }
        : reused && reused.model === model
          ? { model: reused.model, dim: reused.dim, vector: reused.vector }
          : null;
      if (vectorRow) {
        db.prepare(
          `INSERT INTO note_chunk_embeddings (chunk_id, model, dim, vector, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(chunk_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector, updated_at = excluded.updated_at`,
        ).run(chunkId, vectorRow.model, vectorRow.dim, vectorRow.vector, nowIso());
      }
    });

    db.prepare(
      `INSERT INTO ai_index_state (note_id, content_hash, model, chunk_count, status, error, attempts, updated_at)
         VALUES (?, ?, ?, ?, 'indexed', NULL, 0, ?)
         ON CONFLICT(note_id) DO UPDATE SET
           content_hash = excluded.content_hash, model = excluded.model, chunk_count = excluded.chunk_count,
           status = 'indexed', error = NULL, attempts = 0, updated_at = excluded.updated_at`,
    ).run(noteId, noteContentHash, model, chunks.length, nowIso());

    indexVersion += 1; // 向量缓存失效
    return { chunks: chunks.length };
  });
}

export function removeNoteIndex(noteId) {
  removeNoteIndexes([noteId]);
}

/** 批量移除笔记索引（notes.remove 与 vault 同步删除路径共用），并使向量缓存失效 */
export function removeNoteIndexes(noteIds) {
  const ids = [...new Set(noteIds)].filter(Boolean);
  if (!ids.length) return 0;
  const db = getDb();
  const removeChunks = db.prepare('DELETE FROM note_chunks WHERE note_id = ?');
  const removeState = db.prepare('DELETE FROM ai_index_state WHERE note_id = ?');
  withTransaction(() => {
    for (const id of ids) {
      removeChunks.run(id);
      removeState.run(id);
    }
  });
  indexVersion += 1; // 向量缓存失效
  return ids.length;
}

/**
 * 暴力余弦检索全库分块。queryVector 已由调用方 embedding 好最新模型维度。
 * 结果集由内存缓存（可开关）供给；excludeNoteId 在扫描时过滤。
 * @returns {Array<{ chunkId, noteId, anchor, content, score }>}
 */
export function searchVectors(queryVector, { limit = 12, model, excludeNoteId = null } = {}) {
  const entries = loadVectorEntries(model);
  const scored = [];
  for (const entry of entries) {
    if (entry.dim !== queryVector.length) continue;
    if (excludeNoteId && entry.noteId === excludeNoteId) continue;
    const score = cosineSimilarity(queryVector, entry.vector);
    if (score > 0.05) scored.push({ chunkId: entry.chunkId, noteId: entry.noteId, anchor: entry.anchor, content: entry.content, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** 一篇笔记的平均向量（相关笔记推荐用），无向量时返回 null */
export function noteMeanVector(noteId, model) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT e.vector, e.dim FROM note_chunk_embeddings e
       JOIN note_chunks c ON c.id = e.chunk_id
      WHERE c.note_id = ? AND e.model = ?`,
  ).all(noteId, model);
  if (!rows.length) return null;
  const dim = rows[0].dim;
  const mean = new Float32Array(dim);
  let count = 0;
  for (const row of rows) {
    if (row.dim !== dim) continue;
    const vector = unpackVector(row.vector);
    for (let index = 0; index < dim; index += 1) mean[index] += vector[index];
    count += 1;
  }
  if (!count) return null;
  for (let index = 0; index < dim; index += 1) mean[index] /= count;
  return mean;
}

/**
 * 用当前配置的 embedding 模型把若干文本转向量。未配置模型时抛出带 code 的错误，
 * 由路由层翻译成 409，前端据此引导用户先配置 embedding。
 */
export async function embedTexts(texts, { provider = null, priority = null } = {}) {
  const resolved = provider ?? resolveEmbeddingProvider();
  if (!resolved) {
    const error = new Error('尚未配置 embedding 模型，语义功能不可用；请在模型管理中心配置');
    error.code = 'EMBEDDING_NOT_CONFIGURED';
    throw error;
  }
  if (priority === 'chat') lastChatEmbeddingAt = Date.now();
  return callEmbeddingProvider({ inputs: texts, provider: resolved });
}

// ── 对话流量优先 ─────────────────────────────────────────────────────
// 索引批量 embedding 与对话查询共用同一上游配额。对话查询到来时记录时间戳，
// 索引循环在批间让路（短暂 sleep），避免大库重建索引期间对话请求被上游限流。
let lastChatEmbeddingAt = 0;

/** 索引批间调用：近期有对话 embedding 时给上游留出喘息窗口 */
export async function yieldToChatTraffic({ idleWindowMs = 5_000, minGapMs = 250 } = {}) {
  const sinceChat = Date.now() - lastChatEmbeddingAt;
  if (sinceChat >= idleWindowMs || sinceChat >= minGapMs) return;
  await new Promise((resolve) => setTimeout(resolve, minGapMs - sinceChat));
}

/** 当前索引统计（模型中心 / 索引状态面板用） */
export function indexStatus() {
  const db = getDb();
  const provider = resolveEmbeddingProvider();
  const totalNotes = db.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
  const states = db.prepare(
    `SELECT status, COUNT(*) AS c, COALESCE(SUM(chunk_count), 0) AS chunks FROM ai_index_state GROUP BY status`,
  ).all();
  const byStatus = Object.fromEntries(states.map((row) => [row.status, row.c]));
  const totalChunks = states.reduce((sum, row) => sum + row.chunks, 0);
  // 失败原因直接透出：否则上游 400/401 只能靠开库排查，面板上永远只有一句通用文案
  const latestError = db.prepare(
    `SELECT error, updated_at FROM ai_index_state
      WHERE status = 'failed' AND error IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`,
  ).get();
  return {
    configured: Boolean(provider),
    model: provider?.model ?? null,
    totalNotes,
    indexed: byStatus.indexed ?? 0,
    pending: byStatus.pending ?? 0,
    failed: byStatus.failed ?? 0,
    totalChunks,
    latestError: latestError ? { message: latestError.error, updatedAt: latestError.updated_at } : null,
  };
}
