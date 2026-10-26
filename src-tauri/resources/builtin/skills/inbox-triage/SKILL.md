---
name: inbox-triage
description: 读取 Inbox 待整理内容，判断最可能的项目归属与去向，产出可确认的分流清单并说明判定依据。当用户说「整理 Inbox」「收件箱清一下」「这条属于哪个项目」，或问「这些收集的内容放哪」时使用；未经确认不移动条目。
metadata:
  lattice.title: Inbox 内容分流
  lattice.version: 2.0.0
---
# Inbox 内容分流

只处理 status 为 captured 或 processing 的 Inbox 内容。先读取内容，再查询已有项目目录和相关笔记。

对每条内容输出：原路径、候选项目、置信度、判断依据和是否建议归档。置信度不足时必须标记为 uncertain，保留在 Inbox，不得猜测。

不要执行移动、归档或删除操作。这个 Skill 只负责分析和提出决定。
