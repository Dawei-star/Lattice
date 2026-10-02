/**
 * 检索层：把用户问题变成「带编号、可校验的知识上下文」。
 *
 * 双路召回 + RRF 融合（Open WebUI 验证过的混合检索模式）：
 *   1. 关键词路：复用既有 notes_fts（trigram，对中文子串友好）→ 候选笔记的分块
 *   2. 语义路：query embedding → 全库分块暴力余弦
 * 命中后组装成编号上下文 [1]..[n] 注入 prompt；模型用 [n] 标注引用，
 * 服务端校验标号合法性后还原成 references（杜绝编造笔记路径）。
 *
 * 「读全文」逃生门：命中笔记足够小（<2000 字）时整文注入，
 * 缓解 AnythingLLM 式「模型只看到切块、看不到全文」的经典抱怨。
 */
import { getDb } from '../../db/index.js';
import { toPlainText } from '../../lib/markdown.js';
import * as searchService from '../search/search.service.js';
import { chunkEmbedText, embedTexts, searchVectors, noteMeanVector } from './ai.embeddings.js';
import { loadServerSettings } from './ai.settings.js';

const RRF_K = 60;
const MAX_CONTEXT_BLOCKS = 6;
const CHUNK_EXCERPT_CHARS = 700;
const WHOLE_NOTE_MAX_WORDS = 2000;
const MAX_KEYWORD_NOTES = 8;

/**
 * 混合检索。返回 { blocks, debug }；语义路不可用（未配置/未索引）时自动退化为纯关键词。
 * @returns {Promise<{ blocks: Array<{key,noteId,title,filePath,anchor,excerpt}>, debug: object }>}
 */
export async function retrieveContext(query, { excludeNoteId = null } = {}) {
  const keywordBlocks = keywordChannel(query, { excludeNoteId });
  let semanticBlocks = [];
  let semanticError = null;

  try {
    const [queryVector] = await embedTexts([query]);
    if (queryVector) {
      const state = currentEmbeddingModel();
      semanticBlocks = searchVectors(queryVector, { limit: MAX_CONTEXT_BLOCKS * 2, model: state, excludeNoteId })
        .map((hit) => ({
          key: `vec:${hit.chunkId}`,
          noteId: hit.noteId,
          anchor: hit.anchor,
          excerpt: hit.content.slice(0, CHUNK_EXCERPT_CHARS),
          score: hit.score,
          channel: 'semantic',
        }));
    }
  } catch (error) {
    semanticError = error?.message ?? '语义检索失败';
  }

  const merged = fuse(keywordBlocks, semanticBlocks);
  const blocks = finalizeBlocks(merged, { excludeNoteId });
  return {
    blocks,
    debug: {
      keyword: keywordBlocks.slice(0, 10),
      semantic: semanticBlocks.slice(0, 10),
      semanticError,
      merged: blocks,
    },
  };
}

function currentEmbeddingModel() {
  // searchVectors 按模型过滤：只用「当前配置模型」产生的向量，
  // 换模型后的旧向量在重建前不参与检索，避免维度错配。
  return loadServerSettings().embedding?.model ?? null;
}

/** 关键词路：FTS 命中笔记 → 取这些笔记的分块（无分块时退回笔记正文摘要） */
function keywordChannel(query, { excludeNoteId }) {
  let hits = [];
  try {
    hits = searchService.search(query, MAX_KEYWORD_NOTES).items ?? [];
  } catch {
    hits = [];
  }

  const blocks = [];
  const db = getDb();
  for (const hit of hits) {
    if (excludeNoteId && hit.id === excludeNoteId) continue;
    const note = db.prepare('SELECT id, title, file_path, content, word_count FROM notes WHERE id = ?').get(hit.id);
    if (!note) continue;
    const chunks = db.prepare(
      'SELECT id, anchor, content FROM note_chunks WHERE note_id = ? ORDER BY ordinal',
    ).all(note.id);
    if (chunks.length) {
      // 只取与 query 词面相关的分块，避免整篇塞进上下文
      for (const chunk of chunks) {
        if (containsQueryTerm(chunk.content, query) || containsQueryTerm(chunk.anchor, query)) {
          blocks.push({
            key: `fts:${chunk.id}`,
            noteId: note.id,
            anchor: chunk.anchor,
            excerpt: chunk.content.slice(0, CHUNK_EXCERPT_CHARS),
            score: 1,
            channel: 'keyword',
          });
        }
      }
      if (!blocks.some((block) => block.noteId === note.id)) {
        blocks.push({
          key: `fts:${chunks[0].id}`,
          noteId: note.id,
          anchor: chunks[0].anchor,
          excerpt: chunks[0].content.slice(0, CHUNK_EXCERPT_CHARS),
          score: 1,
          channel: 'keyword',
        });
      }
    } else {
      blocks.push({
        key: `fts:note:${note.id}`,
        noteId: note.id,
        anchor: '',
        excerpt: toPlainText(note.content).slice(0, CHUNK_EXCERPT_CHARS),
        score: 1,
        channel: 'keyword',
      });
    }
  }
  return blocks;
}

function containsQueryTerm(text, query) {
  const terms = String(query).split(/[\s,，。;；、]+/).map((term) => term.trim()).filter((term) => term.length >= 2);
  if (!terms.length) return true;
  const lower = String(text).toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

/** RRF 融合双路结果（按 key 去重） */
function fuse(keywordBlocks, semanticBlocks) {
  const scores = new Map();
  const byKey = new Map();
  keywordBlocks.forEach((block, rank) => {
    const contribution = 1 / (RRF_K + rank + 1);
    scores.set(block.key, (scores.get(block.key) ?? 0) + contribution);
    byKey.set(block.key, block);
  });
  semanticBlocks.forEach((block, rank) => {
    const contribution = 1 / (RRF_K + rank + 1);
    scores.set(block.key, (scores.get(block.key) ?? 0) + contribution);
    if (!byKey.has(block.key)) byKey.set(block.key, block);
  });
  return [...scores.entries()]
    .map(([key, score]) => ({ ...byKey.get(key), rrfScore: score }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

/** 截取前 N 块；小笔记直接升级为整文注入（全文逃生门） */
function finalizeBlocks(merged, { excludeNoteId }) {
  const blocks = [];
  const seenNotes = new Set();
  const db = getDb();
  for (const block of merged) {
    if (blocks.length >= MAX_CONTEXT_BLOCKS) break;
    if (seenNotes.has(block.noteId) && seenNotes.size >= 3 && blocks.length >= 3) {
      // 同一篇笔记的多块命中：保留第一块即可，把名额让给别的笔记
      continue;
    }
    const note = db.prepare('SELECT id, title, file_path, content, word_count FROM notes WHERE id = ?').get(block.noteId);
    if (!note) continue;
    const wholeNote = note.word_count > 0 && note.word_count <= WHOLE_NOTE_MAX_WORDS;
    blocks.push({
      noteId: note.id,
      title: note.title,
      filePath: note.file_path,
      anchor: wholeNote ? '' : block.anchor,
      excerpt: wholeNote ? toPlainText(note.content) : block.excerpt,
      wholeNote,
    });
    seenNotes.add(note.id);
  }
  return blocks.filter((block) => !excludeNoteId || block.noteId !== excludeNoteId);
}

/** 组装注入 prompt 的编号上下文与「编号 → 引用对象」映射 */
export function buildContextSections(blocks) {
  const lines = [];
  const citations = blocks.map((block, index) => ({
    number: index + 1,
    noteId: block.noteId,
    title: block.title,
    filePath: block.filePath,
    anchor: block.anchor,
    excerpt: block.excerpt.slice(0, 160),
  }));
  blocks.forEach((block, index) => {
    const anchor = block.anchor ? ` ＞ ${block.anchor}` : '';
    lines.push(`[${index + 1}] 《${block.title}》${anchor}${block.wholeNote ? '（全文）' : ''}\n${block.excerpt}`);
  });
  return { text: lines.join('\n\n'), citations };
}

/**
 * 相关笔记推荐（Reor/Smart Connections 验证的形态）：
 * 以目标笔记的平均向量查全库，聚到笔记粒度取前 N。
 */
export async function relatedNotes(noteId, { limit = 6 } = {}) {
  const model = currentEmbeddingModel();
  if (!model) {
    const error = new Error('尚未配置 embedding 模型');
    error.code = 'EMBEDDING_NOT_CONFIGURED';
    throw error;
  }
  const mean = noteMeanVector(noteId, model);
  if (!mean) return [];

  const hits = searchVectors(mean, { limit: limit * 4, model, excludeNoteId: noteId });
  const grouped = new Map();
  for (const hit of hits) {
    const current = grouped.get(hit.noteId);
    if (!current || hit.score > current.score) {
      grouped.set(hit.noteId, { noteId: hit.noteId, score: hit.score, anchor: hit.anchor, excerpt: hit.content.slice(0, 120) });
    }
  }
  const results = [...grouped.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const db = getDb();
  return results.map((item) => {
    const note = db.prepare('SELECT id, title, file_path, updated_at FROM notes WHERE id = ?').get(item.noteId);
    return {
      id: item.noteId,
      title: note?.title ?? '(已删除)',
      filePath: note?.file_path ?? '',
      updatedAt: note?.updated_at ?? null,
      score: Number(item.score.toFixed(4)),
      anchor: item.anchor,
      excerpt: item.excerpt,
    };
  }).filter((item) => item.id);
}

/**
 * 引用校验：把模型回复里的 [n] 标号映射回真实检索块，剔除越界引用。
 * @param {string} reply 模型回复文本
 * @param {Array} citations buildContextSections 返回的 citations
 * @returns {{ validated: Array, usedNumbers: Set<number> }}
 */
export function validateCitations(reply, citations) {
  const used = new Set();
  for (const match of String(reply ?? '').matchAll(/\[(\d{1,2})\]/g)) {
    const number = Number(match[1]);
    if (citations.some((citation) => citation.number === number)) used.add(number);
  }
  const validated = citations
    .filter((citation) => used.has(citation.number))
    .map(({ number, noteId, title, filePath, anchor, excerpt }) => ({
      number,
      id: noteId,
      title,
      path: filePath,
      anchor,
      excerpt,
    }));
  // 模型没标引用时，退而给出全部命中块作为「参考来源」（明确标注非模型自选）
  const source = validated.length
    ? validated
    : citations.slice(0, 3).map(({ number, noteId, title, filePath, anchor, excerpt }) => ({
        number, id: noteId, title, path: filePath, anchor, excerpt, inferred: true,
      }));
  return { validated, references: source };
}

/** 检索调试视图（FastGPT 式「看命中」）：不调用模型，只返回双路命中与融合结果 */
export async function debugRetrieval(query) {
  const { blocks, debug } = await retrieveContext(query);
  return { query, blocks, ...debug };
}
