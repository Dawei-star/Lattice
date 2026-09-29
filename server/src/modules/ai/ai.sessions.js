/**
 * AI 对话会话存储（SQLite）。
 *
 * 此前对话历史只存浏览器 localStorage（40 条上限、换端失忆、CLI 完全拿不到）。
 * 现在会话与消息入库：多端共享、可回溯、作为模型长期上下文的唯一来源。
 * 消息的 payload 列保存结构化结果（引用/建议/meta），前端据此完整还原回复。
 */
import { randomUUID } from 'node:crypto';
import { getDb, withTransaction } from '../../db/index.js';
import { nowIso } from '../../lib/time.js';

export function listSessions({ limit = 50 } = {}) {
  const rows = getDb()
    .prepare('SELECT id, title, created_at, updated_at FROM ai_sessions ORDER BY updated_at DESC LIMIT ?')
    .all(Math.min(Math.max(Number(limit) || 50, 1), 200));
  return rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }));
}

export function createSession({ title = '新对话', id = randomUUID() } = {}) {
  const db = getDb();
  const timestamp = nowIso();
  db.prepare('INSERT INTO ai_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, String(title).slice(0, 120) || '新对话', timestamp, timestamp);
  return { id, title: String(title).slice(0, 120) || '新对话', createdAt: timestamp, updatedAt: timestamp };
}

export function getSession(id) {
  return getDb().prepare('SELECT id, title, created_at, updated_at FROM ai_sessions WHERE id = ?').get(id) ?? null;
}

export function renameSession(id, title) {
  const db = getDb();
  const result = db.prepare('UPDATE ai_sessions SET title = ?, updated_at = ? WHERE id = ?')
    .run(String(title).slice(0, 120) || '新对话', nowIso(), id);
  return result.changes > 0;
}

export function deleteSession(id) {
  return getDb().prepare('DELETE FROM ai_sessions WHERE id = ?').run(id).changes > 0;
}

export function deleteEmptySessions() {
  // 清理没有任何消息、且创建超过一天的空会话（用户点了「新对话」但没说话）
  getDb().prepare(
    `DELETE FROM ai_sessions
       WHERE updated_at < datetime('now', '-1 day')
         AND NOT EXISTS (SELECT 1 FROM ai_messages WHERE ai_messages.session_id = ai_sessions.id)`,
  ).run();
}

/**
 * 会话消息列表。模型上下文（供 ai.service 拼装）与前端还原（含 payload）两种形态。
 * @param {{ forModel?: boolean, limit?: number }} options
 */
export function listMessages(sessionId, { forModel = false, limit = 200 } = {}) {
  const rows = getDb()
    .prepare('SELECT id, role, content, payload, created_at FROM ai_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?')
    .all(sessionId, Math.min(Math.max(Number(limit) || 200, 1), 500));
  const mapped = rows.map((row) => {
    let payload = null;
    try {
      payload = row.payload ? JSON.parse(row.payload) : null;
    } catch {
      payload = null;
    }
    return { id: row.id, role: row.role, content: row.content, payload, createdAt: row.created_at };
  });
  if (!forModel) return mapped;
  return mapped
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content }));
}

/** 追加一条消息并触碰会话时间戳；可选地把第一条用户消息提炼为会话标题 */
export function appendMessage(sessionId, { role, content, payload = null, autotitle = false }) {
  return withTransaction(() => {
    const db = getDb();
    const timestamp = nowIso();
    const id = randomUUID();
    db.prepare('INSERT INTO ai_messages (id, session_id, role, content, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, role, String(content ?? ''), payload ? JSON.stringify(payload) : null, timestamp);
    let title = null;
    if (autotitle) {
      const first = db.prepare(
        "SELECT content FROM ai_messages WHERE session_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1",
      ).get(sessionId);
      if (first) {
        title = String(first.content).replace(/\s+/g, ' ').trim().slice(0, 40) || '新对话';
        db.prepare('UPDATE ai_sessions SET title = ? WHERE id = ?').run(title, sessionId);
      }
    }
    db.prepare('UPDATE ai_sessions SET updated_at = ? WHERE id = ?').run(timestamp, sessionId);
    return { id, role, content: String(content ?? ''), payload, createdAt: timestamp, ...(title ? { sessionTitle: title } : {}) };
  });
}
