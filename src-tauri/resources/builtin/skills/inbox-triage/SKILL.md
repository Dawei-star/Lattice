# Inbox 内容分流

只处理 status 为 captured 或 processing 的 Inbox 内容。先读取内容，再查询已有项目目录和相关笔记。

对每条内容输出：原路径、候选项目、置信度、判断依据和是否建议归档。置信度不足时必须标记为 uncertain，保留在 Inbox，不得猜测。

不要执行移动、归档或删除操作。这个 Skill 只负责分析和提出决定。
