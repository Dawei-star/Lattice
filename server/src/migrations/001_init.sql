-- 001_init：格物 Lattice 初始 Schema
-- 说明：所有时间统一存 ISO-8601 UTC 字符串，便于跨时区与排序。

-- ── 文件夹（支持任意层级嵌套，parent_id 为空表示根级） ────────────────
CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES folders (id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 同级目录不允许重名（根级 parent_id 为 NULL，用 IFNULL 归一化后建唯一索引）
CREATE UNIQUE INDEX ux_folders_parent_name ON folders (IFNULL(parent_id, ''), name);
CREATE INDEX ix_folders_parent ON folders (parent_id);

-- ── 笔记 ─────────────────────────────────────────────────────────────
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  folder_id  TEXT REFERENCES folders (id) ON DELETE SET NULL,
  is_pinned  INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ix_notes_folder ON notes (folder_id);
CREATE INDEX ix_notes_recent ON notes (is_pinned DESC, updated_at DESC);

-- ── 标签 ─────────────────────────────────────────────────────────────
CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_tags_name ON tags (name COLLATE NOCASE);

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX ix_note_tags_tag ON note_tags (tag_id);

-- ── 双向链接 ─────────────────────────────────────────────────────────
-- 一行 = 源笔记正文里出现的一处 [[目标标题]]。
-- target_note_id 为 NULL 表示「悬空链接」：目标笔记尚不存在，可在 UI 上点击创建。
CREATE TABLE links (
  source_note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  target_title   TEXT NOT NULL,
  target_note_id TEXT REFERENCES notes (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (source_note_id, target_title)
);

CREATE INDEX ix_links_target ON links (target_note_id);

-- ── 全文索引 ─────────────────────────────────────────────────────────
-- 使用 trigram 分词器：它按 3 字符滑窗建索引，因此对中文可做子串匹配，
-- 而 SQLite 默认的 unicode61 会把一整串汉字当作单个词，中文搜索基本失效。
-- note_id 声明为 UNINDEXED，仅作为回表关联键。
CREATE VIRTUAL TABLE notes_fts USING fts5 (
  note_id UNINDEXED,
  title,
  content,
  tokenize = 'trigram'
);

-- 触发器保证 FTS 与主表强一致，业务层无需手工维护索引
CREATE TRIGGER trg_notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (note_id, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER trg_notes_fts_delete AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE note_id = old.id;
END;

CREATE TRIGGER trg_notes_fts_update AFTER UPDATE OF title, content ON notes BEGIN
  DELETE FROM notes_fts WHERE note_id = old.id;
  INSERT INTO notes_fts (note_id, title, content) VALUES (new.id, new.title, new.content);
END;
