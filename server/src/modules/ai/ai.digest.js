/**
 * 每日摘要：把「最近 24 小时修改过的笔记」汇总成一篇真实笔记（Journal 目录）。
 *
 * - 有外部模型时让模型给一段当日总览；没有则用确定性汇总，功能永远可用；
 * - 幂等：同一天重复生成只更新那一篇（标题含日期，文件路径固定）；
 * - 定时：AI_DIGEST_HOUR（0-23）设置后服务端每小时检查一次到点自动生成；
 *   未设置则只能手动触发（避免未经同意往用户库里写笔记）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.js';
import { getDb } from '../../db/index.js';
import { toPlainText } from '../../lib/markdown.js';
import { createLogger } from '../../lib/logger.js';
import * as foldersService from '../folders/folders.service.js';
import * as notesService from '../notes/notes.service.js';
import { callChatProvider } from './ai.provider.js';
import { resolveChatProvider } from './ai.settings.js';

const logger = createLogger({ app: 'lattice', scope: 'ai-digest' });

const DIGEST_FOLDER = 'Journal';
// 记录最近一次定时摘要的日期：机器在配置小时关机/休眠时，之后启动可补跑当天的摘要
const DIGEST_STATE_FILE = path.join(path.dirname(config.dbFile), 'ai-digest-state.json');

export function digestTitleFor(date = new Date()) {
  const iso = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString();
  return `每日摘要 ${iso.slice(0, 10)}`;
}

function digestFilePathFor(date = new Date()) {
  const iso = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString();
  return `${DIGEST_FOLDER}/每日摘要 ${iso.slice(0, 10)}.md`;
}

/** 收集当天（本地时区零点起）修改的笔记（含正文，供摘录） */
function collectRecentNotes({ date = new Date() } = {}) {
  const db = getDb();
  const midnight = new Date(date);
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.toISOString();
  return db.prepare(
    `SELECT id, title, content, word_count, updated_at FROM notes
      WHERE updated_at >= ? AND COALESCE(file_path, '') NOT LIKE '${DIGEST_FOLDER}/每日摘要%'
      ORDER BY updated_at DESC LIMIT 50`,
  ).all(since).map((row) => ({
    id: row.id,
    title: row.title,
    wordCount: row.word_count,
    updatedAt: row.updated_at,
    excerpt: toPlainText(row.content).replace(/\s+/g, ' ').trim().slice(0, 120),
  }));
}

async function buildAiOverview(recentNotes, provider) {
  if (!provider || !recentNotes.length) return '';
  const lines = recentNotes.slice(0, 20).map((note) => `- 《${note.title}》：${note.excerpt || '（无正文摘录）'}`).join('\n');
  try {
    const call = await callChatProvider({
      messages: [
        { role: 'system', content: '你是 Lattice 的每日摘要助手。根据用户今天修改的笔记列表，用 2-3 句话概括今天的工作脉络与关注点。只输出这段话，不要标题、不要列表、不要客套。' },
        { role: 'user', content: `今天修改的笔记：\n${lines}` },
      ],
      provider,
      temperature: 0.3,
      maxTokens: 300,
    });
    return call.raw.trim();
  } catch (error) {
    logger.warn('digest_ai_overview_failed', { err: error });
    return '';
  }
}

/**
 * 生成（或更新）今日摘要笔记。
 * @returns {{ noteId, title, filePath, created, modifiedCount, aiOverview: boolean }}
 */
export async function generateDigest({ date = new Date() } = {}) {
  const recentNotes = collectRecentNotes({ date });
  const provider = resolveChatProvider(null);
  const aiOverview = await buildAiOverview(recentNotes, provider);

  const title = digestTitleFor(date);
  const sections = [
    `# ${title}`,
    '',
    aiOverview || (recentNotes.length
      ? `今天共修改 ${recentNotes.length} 篇笔记。`
      : '最近 24 小时没有修改过笔记。'),
    '',
    '## 修改的笔记',
    '',
    ...(recentNotes.length
      ? recentNotes.map((note) => `- [[${note.title}]]（${note.wordCount} 字，${new Date(note.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新）${note.excerpt ? `\n  > ${note.excerpt}` : ''}`)
      : ['- （无）']),
    '',
    '---',
    `由 Lattice AI 自动生成于 ${new Date().toLocaleString('zh-CN')}${provider ? '（含 AI 总览）' : '（本地模式）'}。`,
  ];
  const content = sections.join('\n');

  // 幂等：按固定路径找旧摘要，有则更新，无则创建
  const db = getDb();
  const filePath = digestFilePathFor(date);
  const existing = db.prepare('SELECT id FROM notes WHERE file_path = ?').get(filePath);
  if (existing) {
    await notesService.update(existing.id, { content });
    return { noteId: existing.id, title, filePath, created: false, modifiedCount: recentNotes.length, aiOverview: Boolean(aiOverview) };
  }

  const created = notesService.create({ title, content, folderId: ensureJournalFolder() });
  return { noteId: created.id, title, filePath, created: true, modifiedCount: recentNotes.length, aiOverview: Boolean(aiOverview) };
}

/** Journal 目录不存在则创建（走目录服务，投影与磁盘保持一致）；已存在则复用 */
function ensureJournalFolder() {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM folders WHERE parent_id IS NULL AND name = ?').get(DIGEST_FOLDER);
  if (existing) return existing.id;
  try {
    const folder = foldersService.create({ name: DIGEST_FOLDER, parentId: null });
    return folder.id;
  } catch (error) {
    logger.warn('digest_folder_create_failed', { err: error });
    return null;
  }
}

/** 定时检查（服务端每小时跑一次）：到点且今天还没生成时触发；
 *  错过配置小时（机器关机/休眠）后，当天晚些时候启动或下一次检查仍会补跑。 */
export async function maybeRunScheduledDigest({ now = new Date() } = {}) {
  const hour = config.aiDigestHour;
  if (hour === null || hour === undefined) return null;

  const today = localDateString(now);
  if (readDigestState().lastRunDate === today) return null;
  // 还没到配置时刻（补跑也只在当天过了配置点之后才发生）
  if (now.getHours() < hour) return null;

  const db = getDb();
  const filePath = digestFilePathFor(now);
  const existing = db.prepare('SELECT id FROM notes WHERE file_path = ?').get(filePath);
  if (existing) {
    writeDigestState(today);
    return null;
  }
  logger.info('digest_scheduled_run', { catchUp: now.getHours() !== hour });
  const result = await generateDigest({ date: now });
  writeDigestState(today);
  return result;
}

function localDateString(date) {
  const iso = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString();
  return iso.slice(0, 10);
}

function readDigestState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DIGEST_STATE_FILE, 'utf8'));
    return typeof parsed?.lastRunDate === 'string' ? parsed : {};
  } catch {
    return {};
  }
}

function writeDigestState(date) {
  try {
    fs.mkdirSync(path.dirname(DIGEST_STATE_FILE), { recursive: true });
    fs.writeFileSync(DIGEST_STATE_FILE, JSON.stringify({ lastRunDate: date }), 'utf8');
  } catch (error) {
    logger.warn('digest_state_write_failed', { err: error });
  }
}
