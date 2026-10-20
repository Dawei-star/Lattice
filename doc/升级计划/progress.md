# 格物 Lattice 升级进度看板

> **刷新规则**：每完成一个执行任务立即更新本文件（用户要求）。
> 详细逐节点记录见 [execution-log.md](execution-log.md)；基线数据见 [baseline.md](baseline.md)；契约核销见 [ipc-contract.md](ipc-contract.md)。
> **最后更新**：2026-10-17 ｜ P3 桌面 AI 辅助能力接入与 MCP 项目配置 IPC 已落地；会话正文、MCP sidecar、签名发布仍受边界约束

## 总进度（按计划工期加权：29 周基准）

**总体 ≈ 32%**（P0 完成；P1 原生核心与桌面 AI 主链已收口；P3/P4 仍有外部运行时验收项）

| 阶段 | 工期 | 进度 | 状态 | Gate |
|---|---|---|---|---|
| P0 准备与基线冻结 | 1 周 | 100% | ✅ 完成 | **M0 达成**（CI 四 job 全绿） |
| P1 原生核心与写入边界 | 11 周 | 100% | ✅ 条件完成 | M1 需运行态复核 |
| P2 编辑器投影（BlockSuite） | 5 周 | 0% | ⬜ | M2 |
| P3 AI 本地化与向量索引 | 7 周 | ≈70% | 🔄 进行中 | M3 需真实模型质量样本 |
| P4 MCP/插件与发布 | 5 周 | ≈15% | 🔄 进行中 | M4 需 sidecar、签名与三平台构建 |

## P1 内部进度

- [x] P1-01 WorkspaceService 统一写入边界（锁/审计/快照/错误模型）
- [x] P1-02 SQLite 恢复/迁移事务化/迁移前备份
- [x] P1-03 watcher reconcile + 持久化 jobs 队列
- [x] P1-04 非 AI 命令面迁移 ✅ 完成
  - [x] tags 投影（`tag_list`）
  - [x] notes 模型地基（frontmatter 解析/字数口径/迁移 004-005/`note_index`）
  - [x] `note_create`（confirmed 闸门/id 幂等/路径递增分配）
  - [x] `note_update`（乐观锁 409/标题重命名原子 rename/无变化短路）
  - [x] `note_delete`（双确认闸门/文件+投影清理/历史快照保留）
  - [x] `search_query`（strategy 枚举 fts/like/like-fallback + mapRow 形状）
  - [x] `note_history_list/get/restore`（快照哈希完整性校验、恢复走写边界自动快照）
  - [x] links 投影（迁移 006 + wiki-link 解析）+ `graph_build`（nodes/edges/dangling/stats）
  - [x] `folder_tree`（磁盘派生目录树+直属计数）+ 迁移 007 notes.folder_id 回填（**Δ2 解决**）
  - [x] folders 全套（tree/create/update/delete；磁盘为真源，rename 子树移动 + scan 自愈；delete 仅限空目录双确认）
  - [x] `meta_overview`（六项统计 + 悬空链接列表）
  - [x] canvas 全套（list/read/write/move/delete；revision 乐观锁、新建确认、删除双确认、Obsidian JSON 兼容）
  - [x] vault attachments 核心 4（list/upload/delete/references；引用由笔记正文派生、被引用拒绝删除、25MB+MIME 白名单）
  - [x] attachments 剩余（`vault_files_list`/`vault_attachment_validate`/`vault_attachment_cleanup`/`vault_download`；cleanup 双确认 + 被引用保护）
  - [x] files 全套 7（`file_read`/`file_find`/`file_grep`/`file_preview`/`file_execute`/`file_undo`/`file_log`；planHash 校验→.fc 快照→原子落盘→审计→undo 还原，delete 双确认）
  - [x] experts/skills 全套 9（`expert_list/get/save/delete/route` + `skill_list/get/save/delete`；内置 7 专家 9 技能编译期嵌入，工作区层 `.lattice/experts|skills`，workspace 覆盖 builtin、保存/删除双确认闸门）
  - [x] review 3（`review_health`/`review_plan`/`review_execute`；9 类线索扫描 + 健康分，修复计划内存 TTL 15min + planHash + contentHash 重校验）
- [x] **P1-04 非 AI 命令面迁移全部完成**（96 端点中非 AI/MCP 侧 60 个全部迁移）
- [x] P1-05 api 层 TS 化（12 模块 git mv 转 .ts + 类型标注，零运行时改动；测试 import 改 .ts 后缀走 Node 24 type stripping；tsconfig 开 allowImportingTsExtensions）
- [x] P1-06 hooks/lib TS 化（20 文件 git mv 转 .ts/.tsx + 类型标注；11 个测试 import 改 .ts；顺修类型化揭出的 2 处既有 bug：useToast dedupe 反向清理失效、static-export 索引页 rows.map→notes.map）
- [x] P1-07 components/shell/settings 全量 .jsx → .tsx（当前 `web/src` 已无 `.jsx/.js` 组件源文件）
- [x] P1-05 收尾项：api 层 invoke 双轨封装（桌面通道 invoke / 浏览器 HTTP 兼容分支）+ 入口切全功能 App
- [x] P1-08 功能对齐验证（IPC 路由、参数、双通道消费和 Rust parity 测试已通过）
- [x] P1-09 删除 Express 回落（桌面端未映射能力统一 `IPC_UNAVAILABLE`；SSE 也不再绕过 IPC）
- [x] P1-10 本地验收门禁（Web/Rust/契约/构建脚本已核对；真实模型、运行态性能、签名发布列为外部验收）

## IPC 命令核销（契约清单 96 端点）

**已迁移 60 个**（在原 59 个基础上增加 `update_check`；vault 9 + jobs 3 + tag_list + note_index + note CRUD 3 + search_query + history 3 + graph_build + folders 4 + meta_overview + canvas 5 + attachments 8 + files 7 + experts/skills 9 + review 3 + vault_download 等计入 vault 侧）
**剩余受限能力**：AI 会话正文不写入 SQLite/checkpoint/durable result，桌面继续使用浏览器本地会话索引；MCP stdio/SSE sidecar、工具授权/生命周期、健康探针、自动安装更新和签名发布仍未完成。MCP 项目配置读写已由 Rust IPC 提供，包含确认、路径检查、归一化、原子写和审计，但不会启动外部 Server。AI 主对话、检索、相关笔记、双链/标签建议、本地每日摘要、Provider 测试、索引、写作流、更新检查和操作审计由真实 Rust IPC 提供；桌面内联图片通过 `vault_download` IPC + Blob URL 加载。

## 关键问题点（活跃）

- ~~Δ2 folders/UUID 映射~~：已解决（迁移 007 + 确定性目录 id）；已知限制：目录改名后确定性 id 变化（用户排序 sortOrder 特性延后，见 progress 下一步）
- Δ3 CI server-test 曾现 flaky（重跑即绿），已加失败 annotation 机制
- Δ4 运行态性能指标（冷启动/内存）待人工采集

## 下一步

1. 使用真实 Provider/Ollama 在桌面窗口完成 AI 流式、取消、恢复和写作助手运行态采样
2. 真实 Provider/Ollama 运行态质量样本与人工桌面验收；AI 会话正文仍保持本地浏览器存储边界，再进入 MCP sidecar
3. 完成三平台签名构建与发布验收
