# 格物 Lattice 升级执行记录（逐节点状态）

> **计划依据**：[lattice-upgrade-plan.md](lattice-upgrade-plan.md) v1.1 ｜ **执行开始**：2026-10-13
> 本文件按计划节点顺序记录执行状态与结果，每完成一个节点立即追加（计划 §10.2 文档制度）。
> 配套：[baseline.md](baseline.md)（性能与门禁基线）｜ [ipc-contract.md](ipc-contract.md)（契约与不变量）

## 执行环境

- Windows 11 x64 · Node 24.12.0 · npm 11.6.2 · Rust 1.99.0（stable-x86_64-pc-windows-gnu，`~/.cargo/bin` 不在默认 PATH，执行中以全路径注入）
- 仓库分支拓扑：`v0.1.5`（开发主线）/ `main`（发布线，远端落后） / `phase/p0-baseline`（已合并）/ `phase/p1-rust-ai`（P1 执行分支）

## P0 准备与基线冻结

| 节点 | 状态 | 结果 | 证据 |
|---|---|---|---|
| P0-1 基线冻结 | ✅ 完成 | 全量测试绿后提交 `a26ab8d` 并打 tag `v0.1.5-baseline`，已推送 origin | server 194/194；web 全绿；cargo 14/14（修复后）；clippy -D warnings 过；typecheck 过 |
| P0-2 CI 门禁 | ✅ 完成 | `.github/workflows/upgrade-gate.yml` 四 job（web-test/server-test/rust-test/typecheck）；PR/push 到 main+v0.1.5 触发 | CI run #2 全绿（run id 38405080883） |
| P0-3 基线性能 | ⚠️ 部分完成 | 搜索 P95（500/10,000 篇）+ 包体（MSI 9.38MB/NSIS 7.05MB）+ web dist 6.25MB 已归档；**冷启动/首屏/内存/AI TTFT 需运行态人工采集** | [baseline.md](baseline.md) §2/§3 |
| P0-4 IPC 契约清单 | ✅ 完成 | 96 端点逐模块以代码为准核实 + 每项未来 Rust 命令名 + scripts/ 两个 MCP 工作区盘点；自检计数一致 | [ipc-contract.md](ipc-contract.md) |
| P0-5 数据不变量冻结 | ✅ 完成 | I1-I9 冻结（真源/哈希/链接/模型版本/任务恢复/审计/单实例/WAL/零损失），落盘于契约清单 §0 | ipc-contract.md §0 |
| P0-6 WAL 恢复/迁移测试 | ✅ 完成 | 迁移事务化（失败回滚、user_version 不提升）+ WAL 异常退出自恢复 + 重复启动 + 禁删 WAL/SHM 断言，4 个测试常驻 CI | `src-tauri/src/db.rs` tests |
| M0 Gate | ✅ 有条件达成 | 核心判据全部通过；遗留 3 项见"问题点清单" | — |

## P1 原生核心与写入边界（进行中）

| 节点 | 状态 | 结果 | 提交 |
|---|---|---|---|
| P1-01 WorkspaceService | ✅ 完成 | 统一写入边界：单实例锁（VAULT_LOCKED/幂等重开）、JSONL 审计、Express 同构版本快照、ServiceError{code,message} 错误模型；9 个 vault 命令全部经 Service；前端契约文本逐字保持 | `38fad24` |
| P1-02 SQLite 恢复与迁移 | ✅ 完成 | WAL 自恢复/事务迁移/失败诊断（P0-6 完成）+ 迁移前备份 `.bak-pre-migration`（P1-02 补齐） | `8cba5ac` |
| P1-03 单实例锁 + watcher + jobs | ✅ 完成 | 单实例锁（P1-01）；持久化 jobs 队列（迁移 002：幂等 key/重试预算/协作取消/启动恢复）；notify watcher 500ms 防抖入队 reconcile；扫描 worker + vault://changed/scanned 事件；新命令 job_list/job_get/job_cancel | `f1100e1` |
| P1-04 非 AI 命令面迁移 | 🔄 进行中 | **第一批 tags ✅**（`ad945df`：标签提取对齐 Express、迁移 003、`tag_list`）。**第二批 notes 模型 ✅**（`0480386`：frontmatter 解析/字数口径/迁移 004-005/`note_index`；随后 `note_create`：confirmed 闸门、id 幂等、路径递增分配、content 列改为正文口径）。**待办**：note_update/delete、search_query 完整形状、folders/graph/meta、canvas/files/experts/review/attachments | `0480386` 及后续 |
| P1-05~07 前端 TS 化 | ⬜ 未开始 | api→store/lib→组件，strict 渐进开启 | — |
| P1-08 功能对齐验证 | ⬜ 未开始 | 契约快照对照（fixtures + Rust 集成测试 + 前端 mock invoke） | — |
| P1-09 删除 Express | ⬜ 未开始 | 依赖 P1-08 全绿 | — |
| P1-10 验收发布 v0.2.0 | ⬜ 未开始 | — | — |

## 问题点清单（按用户要求 #3 标记，未阻塞已完成的节点）

| # | 问题点 | 状态 | 处置建议 |
|---|---|---|---|
| Δ1 | 计划书 §2.1 与现实不符：src-tauri 基线不编译（E0277/E0255/迁移测试错误） | 已解决 | 最小修复 F1-F5 记录于 [baseline.md](baseline.md) §4 |
| Δ2 | 数据模型差异：Express 笔记以 UUID（frontmatter id）寻址，Rust 侧以路径寻址 | ⚠️ 已标记 | P1-04 迁移 notes 命令面时建立 UUID↔路径映射；快照器已按 UUID 兼容 |
| Δ3 | CI run #1 server-test 失败，重跑无代码变更即通过 → 环境抖动（flaky） | ⚠️ 已标记 | 与 reserve-blocked-ports.mjs 注释描述同类；P1-03 jobs 骨架时加固时间敏感断言；CI 已加失败 annotation 报告机制 |
| Δ4 | 运行态性能指标（冷启动/首屏/内存/AI TTFT）无法自动化采集 | ⚠️ 待人工 | 见 baseline.md §3.2 采集方法建议 |
| Δ5 | 契约清单"第二人抽查 10 项"单人执行环境无法满足 | ⚠️ 待补 | 已用逐模块计数自检替代；建议 Gate Review 时由第二人补抽 |
| Δ6 | 远端 main 落后 v0.1.5（发布线未同步 v0.1.5 提交） | ⚠️ 待决策 | 按 §10.2 Gate Review 后合回；不影响升级执行 |
| Δ7 | gh CLI 不可用（workflow_dispatch 无法手动触发） | 已绕过 | CI 由 push 触发 |

## 回滚与数据安全（要求 #4 核验）

- 基线 tag `v0.1.5-baseline` 可随时回退（`git checkout v0.1.5-baseline`）
- P0/P1 变更均不触碰 Vault 用户数据（.md/.canvas/附件零改动，不变量 I9）
- SQLite 迁移事务化 + 迁移前备份 + WAL 自恢复测试常驻（I8）
- Express 双通道仍完整在役（P1-09 前不删除），桌面 IPC 与 HTTP 回落并存
