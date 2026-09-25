-- 002_attachments：附件（图片/文件）台账
-- 说明：附件本体是落盘在 ATTACHMENTS_DIR 的文件，本表只是「账」——
--       用于列出附件、按引用计数清理孤儿文件。正文里以标准 Markdown 图片语法
--       ![[名称]] 之外的 ![alt](/attachments/<stored_name>) 引用它们。
-- 时间统一存 ISO-8601 UTC 字符串，与 001_init 保持一致。

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  stored_name TEXT NOT NULL,               -- 服务端生成的不重名文件名，实际落盘用
  orig_name   TEXT NOT NULL,               -- 用户上传时的原始文件名，仅用于展示
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- stored_name 是对外 URL 的唯一键，必须唯一
CREATE UNIQUE INDEX ux_attachments_stored ON attachments (stored_name);
