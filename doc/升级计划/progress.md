# 格物 Lattice 升级进度看板

> **刷新规则**：每完成一个执行任务立即更新本文件（用户要求）。
> 详细逐节点记录见 [execution-log.md](execution-log.md)；基线数据见 [baseline.md](baseline.md)；契约核销见 [ipc-contract.md](ipc-contract.md)。
> **最后更新**：2026-10-14 ｜ P1-07 完成：components/shell/settings 全量 .jsx→.tsx，strict 类型错误 1343→0（顺修类型化揭出的 1 处既有 bug）

## 总进度（按计划工期加权：29 周基准）

**总体 ≈ 28%**（P0 全部 1 周 + P1 约 8.5/11 周）

| 阶段 | 工期 | 进度 | 状态 | Gate |
|---|---|---|---|---|
| P0 准备与基线冻结 | 1 周 | 100% | ✅ 完成 | **M0 达成**（CI 四 job 全绿） |
| P1 原生核心与写入边界 | 11 周 | ≈77% | 🔄 进行中 | M1 待达成 |
| P2 编辑器投影（BlockSuite） | 5 周 | 0% | ⬜ | M2 |
| P3 AI 本地化与向量索引 | 7 周 | 0% | ⬜ | M3 |
| P4 MCP/插件与发布 | 5 周 | 0% | ⬜ | M4 |

## P1 内部进度

- [x] P1-01 WorkspaceService 统一写入边界（锁/审计/快照/错误模型）
- [x] P1-02 SQLite 恢复/迁移事务化/迁移前备份
- [x] P1-03 watcher reconcile + 持久化 jobs 队列
- [ ] P1-04 非 AI 命令面迁移 ✅ 完成
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
- [x] **P1-04 非 AI 命令面迁移全部完成**（96 端点中非 AI/MCP 侧 59 个全部迁移）
- [x] P1-05 api 层 TS 化（12 模块 git mv 转 .ts + 类型标注，零运行时改动；测试 import 改 .ts 后缀走 Node 24 type stripping；tsconfig 开 allowImportingTsExtensions）
- [x] P1-06 hooks/lib TS 化（20 文件 git mv 转 .ts/.tsx + 类型标注；11 个测试 import 改 .ts；顺修类型化揭出的 2 处既有 bug：useToast dedupe 反向清理失效、static-export 索引页 rows.map→notes.map）
- [x] P1-07 components/shell/settings 全量 .jsx → .tsx（34 文件 git mv；**strict 错误 1343→0**：CanvasView 328 / SettingsModal 252 / FolderTree 199 / AIAssistantPanel 175 / EditorPane 167 / ExpertsCenter 118 / ModelCenter 98 / Sidebar 5 / App 1；顺修 1 处既有 bug：McpServerSettings 作用域引用失效（组件内引用不存在的外层 `onConfirmFileOperation`/`vaultPath`，一旦开启项目级 MCP 必抛 ReferenceError）；`test/ai-motion.test.mjs` 源路径 .jsx→.tsx）
- [ ] P1-05 收尾项（批次 2 未闭环）：api 层 invoke 双轨封装（桌面通道 invoke / Express 回落）+ 入口切全功能 App ← **当前**
- [ ] P1-08 功能对齐验证（契约快照对照）
- [ ] P1-09 删除 Express 回落
- [ ] P1-10 验收发布 v0.2.0

## IPC 命令核销（契约清单 96 端点）

**已迁移 59 个**（vault 9 + jobs 3 + tag_list + note_index + note CRUD 3 + search_query + history 3 + graph_build + folders 4 + meta_overview + canvas 5 + attachments 8 + files 7 + experts/skills 9 + review 3 + vault_download 等计入 vault 侧）
**剩余 37 个**（含 P3 AI 22 个、P4 MCP 3 个、⛔ 废弃 4 个不在迁移范围；引用正则为常见形态近似，P1-08 契约对齐时校准）

## 关键问题点（活跃）

- ~~Δ2 folders/UUID 映射~~：已解决（迁移 007 + 确定性目录 id）；已知限制：目录改名后确定性 id 变化（用户排序 sortOrder 特性延后，见 progress 下一步）
- Δ3 CI server-test 曾现 flaky（重跑即绿），已加失败 annotation 机制 → **已定位疑似成因**：`vault-attachments.test.js` 的符号链接用例是否执行取决于本机 `fs.symlink` 能否成功，见 Δ10
- Δ4 运行态性能指标（冷启动/内存）待人工采集
- **Δ10（新增）** 本机 `server-test` 194→193 失败 1 项：`server/test/vault-attachments.test.js:86`「符号链接指向点目录的下载应 404，实得 200」，3/3 确定性复现；经核验本次 P1-07 提交 **0 个 server 文件**（44 个变更全在 web/），`server/` 工作区干净、最近一次服务端改动早于 P1 全部批次 → 属**预先存在**的环境相关用例（Windows realpath/符号链接语义），非本次引入。CI 跑 ubuntu-latest 不受影响；建议 P1-08 一并核对 Rust `vault_download` 的符号链接/点目录语义后再定 M1 门禁口径
- **Δ11（新增）** 类型化过程中揭出 api 契约层类型过宽（不在 P1-07 改动范围，登记给 P1-08 校准）：`resources.ts` 的 `notesApi.history` 标为 `unknown[]`、`notesApi.historyVersion` 返回 `unknown`、`NoteDetail` 缺 `filePath`；`vault-files.ts` 的 `LatticeDesktopBridge` 缺 `revealVault`/`backupVault`/`exportStaticSite`，`vaultAttachmentsApi.upload` 条目缺 `mimeType`；`canvas.ts` 的 `CanvasDocument.nodes/edges` 为 `unknown[]`。当前以组件侧局部类型 + `as` 断言消化（全仓 `as unknown as` 仅 16 处、`: any` 29 处）

## 下一步

1. P1-05 收尾项（批次 2 未闭环）：api 层 invoke 双轨封装（桌面通道 invoke / Express 回落）+ 入口切全功能 App
2. P1-08 功能对齐验证（契约快照对照）；顺带校准 Δ11 的 api 契约类型
3. P1-08 时复核 Δ10：确认 Rust 侧 `vault_download` 对符号链接/点目录的返回码与 Express 一致，并重采 server-test 基线
