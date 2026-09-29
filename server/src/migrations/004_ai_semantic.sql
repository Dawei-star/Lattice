-- 004_ai_semantic：AI 助手重构 —— 会话持久化、服务端模型配置、语义索引
-- 说明：时间统一存 ISO-8601 UTC 字符串，与既有迁移一致。

-- ── AI 对话会话 ──────────────────────────────────────────────────────
CREATE TABLE ai_sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '新对话',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ix_ai_sessions_recent ON ai_sessions (updated_at DESC);

-- role 仅取 user / assistant / system；payload 保存结构化结果（引用、建议、meta），
-- 前端刷新后据此完整还原一条 AI 回复的引用卡片与建议按钮。
CREATE TABLE ai_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ai_sessions (id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX ix_ai_messages_session ON ai_messages (session_id, created_at);

-- ── 服务端模型配置（Key 不再只存浏览器 localStorage）──────────────────
-- 单机本地应用：Key 与数据库同盘存放，信任边界等同于 SQLite 本身。
-- value 为 JSON 字符串，结构由 ai.settings.js 维护。
CREATE TABLE ai_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── 语义索引：笔记分块 ───────────────────────────────────────────────
-- 一个分块 = 笔记按标题层级切开的一段正文（含标题锚点路径），喂给 embedding 模型的最小单元。
CREATE TABLE note_chunks (
  id           TEXT PRIMARY KEY,
  note_id      TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  anchor       TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX ix_note_chunks_note ON note_chunks (note_id, ordinal);

-- 分块向量：Float32Array 序列化为 BLOB，检索时 JS 暴力余弦
-- （个人库规模 10^4~10^5 向量，单次查询毫秒级；刻意不引入原生向量库依赖）。
CREATE TABLE note_chunk_embeddings (
  chunk_id   TEXT PRIMARY KEY REFERENCES note_chunks (id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ix_note_chunk_embeddings_model ON note_chunk_embeddings (model);

-- ── 索引状态：以「笔记 content_hash + 模型」判断是否需要重建分块 ────────
CREATE TABLE ai_index_state (
  note_id      TEXT PRIMARY KEY REFERENCES notes (id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  model        TEXT NOT NULL,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE INDEX ix_ai_index_state_status ON ai_index_state (status);
