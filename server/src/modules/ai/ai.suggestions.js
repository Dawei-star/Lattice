/**
 * 智能建议：为当前笔记推荐可建立的双链与可补充的标签。
 *
 * 链接建议双轨：
 *   - 语义路：embedding 就绪时用向量近邻（relatedNotes 的能力）；
 *   - 关键词路：从笔记标题提词走 FTS——零配置也能用，只是排序粗糙些。
 * 标签建议：候选来自全库既有标签词表（受控打标，不自由生成），
 *   按标题命中（权重高）与正文命中打分，排除笔记已有的标签。
 *
 * 全部为只读建议，写入由前端确认后走编辑器草稿（不绕过用户）。
 */
import { getDb } from '../../db/index.js';
import { toPlainText } from '../../lib/markdown.js';
import * as searchService from '../search/search.service.js';
import { noteMeanVector, searchVectors } from './ai.embeddings.js';

const DEFAULT_LIMIT = 6;
const MAX_TITLE_TERMS = 4;

/**
 * @param {string} noteId
 * @returns {Promise<{ links: Array, tags: Array, semanticAvailable: boolean }>}
 */
export async function suggestForNote(noteId, { limit = DEFAULT_LIMIT } = {}) {
  const db = getDb();
  const note = db.prepare('SELECT id, title, content, file_path FROM notes WHERE id = ?').get(noteId);
  if (!note) return { links: [], tags: [], semanticAvailable: false };

  const [links, tags, semanticAvailable] = await Promise.all([
    suggestLinks(note, { limit }),
    suggestTags(note, { limit }),
    Promise.resolve(hasVectors(noteId)),
  ]);
  return { links, tags, semanticAvailable };
}

function hasVectors(noteId) {
  try {
    const row = getDb().prepare(
      'SELECT EXISTS(SELECT 1 FROM note_chunk_embeddings e JOIN note_chunks c ON c.id = e.chunk_id WHERE c.note_id = ?) AS has',
    ).get(noteId);
    return row?.has === 1;
  } catch {
    return false;
  }
}

async function suggestLinks(note, { limit }) {
  const db = getDb();
  const excludeIds = new Set([note.id]);
  const excludeTitles = new Set(note.title.trim().toLowerCase());

  // 已有出链不再推荐（无论是否已解析）
  for (const link of db.prepare('SELECT target_title, target_note_id FROM links WHERE source_note_id = ?').all(note.id)) {
    if (link.target_note_id) excludeIds.add(link.target_note_id);
    excludeTitles.add(String(link.target_title).toLowerCase());
  }
  // 已有反链的源笔记也不再推荐（双向都连过的没意义）
  for (const backlink of db.prepare('SELECT source_note_id FROM links WHERE target_note_id = ?').all(note.id)) {
    excludeIds.add(backlink.source_note_id);
  }

  // 语义路优先
  try {
    const settingsRow = getDb().prepare("SELECT value FROM ai_settings WHERE key = 'model-config'").get();
    const model = JSON.parse(settingsRow?.value ?? 'null')?.embedding?.model ?? null;
    if (model) {
      const mean = noteMeanVector(note.id, model);
      if (mean) {
        const hits = searchVectors(mean, { limit: limit * 3, model, excludeNoteId: note.id });
        const results = [];
        const seenNotes = new Set();
        for (const hit of hits) {
          if (excludeIds.has(hit.noteId) || seenNotes.has(hit.noteId)) continue;
          const target = db.prepare('SELECT id, title, file_path FROM notes WHERE id = ?').get(hit.noteId);
          if (!target || excludeTitles.has(target.title.toLowerCase())) continue;
          seenNotes.add(hit.noteId);
          results.push({ id: target.id, title: target.title, filePath: target.file_path, score: Number(hit.score.toFixed(4)), reason: '语义相关' });
          if (results.length >= limit) break;
        }
        if (results.length) return results;
      }
    }
  } catch {
    // 语义路失败（未配置 / 库未迁移）落入关键词路
  }

  // 关键词路：标题分词 + 检索服务（FTS trigram 需要 ≥3 字，短词由其 LIKE 兜底）
  const terms = tokenize(note.title).slice(0, MAX_TITLE_TERMS);
  const results = [];
  const seenNotes = new Set();
  for (const term of terms) {
    if (results.length >= limit) break;
    let rows = [];
    try {
      rows = searchService.search(term, limit * 2).items ?? [];
    } catch {
      rows = [];
    }
    for (const item of rows) {
      if (results.length >= limit) break;
      if (excludeIds.has(item.id) || seenNotes.has(item.id)) continue;
      const row = db.prepare('SELECT id, title, file_path FROM notes WHERE id = ?').get(item.id);
      if (!row || excludeTitles.has(row.title.toLowerCase())) continue;
      seenNotes.add(row.id);
      results.push({ id: row.id, title: row.title, filePath: row.file_path, score: 0.5, reason: `标题词「${term}」命中` });
    }
  }
  return results;
}

async function suggestTags(note, { limit }) {
  const db = getDb();
  let candidates = [];
  try {
    candidates = db.prepare(
      `SELECT t.id, t.name, COUNT(nt.note_id) AS usage
         FROM tags t LEFT JOIN note_tags nt ON nt.tag_id = t.id
        GROUP BY t.id
        ORDER BY usage DESC, t.name ASC
        LIMIT 200`,
    ).all();
  } catch {
    return [];
  }
  if (!candidates.length) return [];

  const existing = new Set(
    db.prepare(
      'SELECT t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ?',
    ).all(note.id).map((row) => row.name.toLowerCase()),
  );

  const plainTitle = note.title.toLowerCase();
  const plainContent = toPlainText(note.content).toLowerCase();

  const scored = [];
  for (const candidate of candidates) {
    const name = candidate.name.toLowerCase();
    if (existing.has(name)) continue;
    const inTitle = plainTitle.includes(name);
    const inContent = plainContent.includes(name);
    if (!inTitle && !inContent) continue;
    scored.push({
      name: candidate.name,
      score: (inTitle ? 3 : 0) + (inContent ? 1 : 0) + Math.min(candidate.usage, 5) * 0.1,
      matchedIn: inTitle ? '标题' : '正文',
      usage: candidate.usage,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ name, score, matchedIn, usage }) => ({
    name,
    score: Number(score.toFixed(2)),
    matchedIn,
    usage,
  }));
}

/** 标题分词：中文字符两两成词（保证 ≥2 字可进 trigram 索引），拉丁词整词保留 */
export function tokenize(title) {
  const text = String(title ?? '').trim();
  const terms = [];
  for (const latin of text.match(/[A-Za-z0-9]{2,}/g) ?? []) terms.push(latin.toLowerCase());
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? [];
  for (let index = 0; index + 1 < cjk.length; index += 1) {
    terms.push(cjk[index] + cjk[index + 1]);
  }
  return [...new Set(terms)].filter((term) => [...term].length >= 2);
}
