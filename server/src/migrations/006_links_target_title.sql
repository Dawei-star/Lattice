-- 006_links_target_title：按未解析标题认领链接（claimDanglingLinks）与按标题统计引用
-- 都以 target_title 过滤，缺索引时每次笔记创建/改名都要全表扫描 links。
CREATE INDEX ix_links_target_title ON links (target_title COLLATE NOCASE);
