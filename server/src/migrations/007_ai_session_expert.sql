-- 007_ai_session_expert：把 AI 会话绑定到创建它的专家，避免切换专家后串用上下文。
ALTER TABLE ai_sessions ADD COLUMN expert_id TEXT NOT NULL DEFAULT 'general';

CREATE INDEX ix_ai_sessions_expert_recent ON ai_sessions (expert_id, updated_at DESC);
