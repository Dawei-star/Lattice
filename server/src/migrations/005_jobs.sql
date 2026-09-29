-- 005_jobs：统一后台任务状态，供索引、摘要、导出和扫描复用。
-- 任务状态可在进程重启后恢复；真实内容仍来自 Vault，任务表只是执行投影。
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  progress        INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  message         TEXT,
  payload         TEXT NOT NULL DEFAULT '{}',
  result          TEXT,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  updated_at      TEXT NOT NULL
);

CREATE INDEX ix_jobs_status_updated ON jobs (status, updated_at DESC);
CREATE INDEX ix_jobs_type_updated ON jobs (type, updated_at DESC);
CREATE UNIQUE INDEX ux_jobs_idempotency ON jobs (type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
