-- 009_ai_chat_metrics：对话请求的性能与结果度量。
-- 只做 append-only 观测投影，不参与业务逻辑；用于 TTFT/耗时/用量/成功率的聚合看板，
-- 也是检索、重试等性能优化上线前后的对照依据。
CREATE TABLE ai_chat_metrics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT NOT NULL,
  expert_id         TEXT NOT NULL DEFAULT 'general',
  session_id        TEXT,
  mode              TEXT NOT NULL DEFAULT 'assist',
  provider_kind     TEXT NOT NULL,
  model             TEXT,
  ttft_ms           INTEGER,
  total_ms          INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  rounds            INTEGER,
  outcome           TEXT NOT NULL CHECK (outcome IN ('done', 'error', 'cancelled')),
  error_kind        TEXT
);

CREATE INDEX ix_ai_chat_metrics_created ON ai_chat_metrics (created_at DESC);
CREATE INDEX ix_ai_chat_metrics_outcome ON ai_chat_metrics (outcome, created_at DESC);
