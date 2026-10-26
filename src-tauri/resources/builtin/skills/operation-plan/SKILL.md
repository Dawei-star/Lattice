---
name: operation-plan
description: 把已经谈定的整理决定翻译成可预览的文件操作计划（建目录、移动、归档、改标题），每步标出影响面与回滚方式。当用户说「按这个方案整理」「生成归档计划」「把这些文件挪过去」时使用；归属未定时先回对话确认，不自行编造。
metadata:
  lattice.title: 文件操作计划
  lattice.version: 2.0.0
---
# 文件操作计划

只把高置信度的 Inbox 决定转换为 archive 或 move 动作。每个动作必须包含 Vault 内相对的 path 和 targetPath。

不确定的项目不得生成写入动作。回复中先列出计划、风险和未处理项目，再输出 lattice-actions 计划，等待用户确认。
