-- P1 增量投影：为每篇笔记记录磁盘文件字节的 sha256。
-- 同步引擎比对哈希即可跳过未变化的文件，不再需要全库 DELETE + INSERT 重建。
ALTER TABLE notes ADD COLUMN content_hash TEXT;

-- 双链解析（resolveTitle / claimDanglingLinks）按 title COLLATE NOCASE 等值查询，
-- 之前每次解析都是全表扫描；外部编辑后的逐篇重建会放大这个成本。
CREATE INDEX ix_notes_title ON notes (title COLLATE NOCASE);
