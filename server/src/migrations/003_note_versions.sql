-- 003_note_versions：笔记版本历史
-- 说明：每次「实质改动」保存前，把被覆盖掉的旧状态存成一条快照（版本 = 过去的状态，
--       当前 notes 行始终是最新态）。为避免自动保存刷屏，按最小时间间隔节流快照，
--       并对每篇笔记保留最近若干条（超出即淘汰）。删除笔记时随外键级联清理其历史。
-- 时间统一存 ISO-8601 UTC 字符串，与 001_init / 002_attachments 一致。

CREATE TABLE note_versions (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  title      TEXT NOT NULL,               -- 快照那一刻的标题
  content    TEXT NOT NULL,               -- 快照那一刻的正文
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL                -- 快照生成时间（即旧状态被覆盖的时刻）
);

-- 列某篇笔记的历史（按时间倒序）与节流判定都走这个复合索引
CREATE INDEX ix_note_versions_note_time ON note_versions (note_id, created_at DESC);
