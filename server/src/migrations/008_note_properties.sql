-- 笔记 frontmatter 属性的投影列。
--
-- properties 只存在于磁盘 Markdown 的 frontmatter 里，而 index()/list()/inbox
-- 过滤每次请求都要解析属性。此前靠进程内 contentHash 版本缓存规避读盘，但
-- 进程重启后第一轮请求仍要全库读盘；把解析结果随投影一起落库后，属性读取
-- 在任何时刻都是纯内存操作（磁盘仍是真源：content_hash 变化会连带动它）。
--
-- NULL 表示「尚未回填」：读路径遇到 NULL 时回读磁盘解析并写回（惰性回填），
-- 存量库因此无需一次性全库扫描。
ALTER TABLE notes ADD COLUMN properties_json TEXT;
