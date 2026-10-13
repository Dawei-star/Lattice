# 格物 Lattice 升级进度看板

> **刷新规则**：每完成一个执行任务立即更新本文件（用户要求）。
> 详细逐节点记录见 [execution-log.md](execution-log.md)；基线数据见 [baseline.md](baseline.md)；契约核销见 [ipc-contract.md](ipc-contract.md)。
> **最后更新**：2026-10-13 ｜ note_create 完成并验证绿

## 总进度（按计划工期加权：29 周基准）

**总体 ≈ 19%**（P0 全部 1 周 + P1 约 5/11 周）

| 阶段 | 工期 | 进度 | 状态 | Gate |
|---|---|---|---|---|
| P0 准备与基线冻结 | 1 周 | 100% | ✅ 完成 | **M0 达成**（CI 四 job 全绿） |
| P1 原生核心与写入边界 | 11 周 | ≈45% | 🔄 进行中 | M1 待达成 |
| P2 编辑器投影（BlockSuite） | 5 周 | 0% | ⬜ | M2 |
| P3 AI 本地化与向量索引 | 7 周 | 0% | ⬜ | M3 |
| P4 MCP/插件与发布 | 5 周 | 0% | ⬜ | M4 |

## P1 内部进度

- [x] P1-01 WorkspaceService 统一写入边界（锁/审计/快照/错误模型）
- [x] P1-02 SQLite 恢复/迁移事务化/迁移前备份
- [x] P1-03 watcher reconcile + 持久化 jobs 队列
- [ ] P1-04 非 AI 命令面迁移 ← **当前**
  - [x] tags 投影（`tag_list`）
  - [x] notes 模型地基（frontmatter 解析/字数口径/迁移 004-005/`note_index`）
  - [x] `note_create`（confirmed 闸门/id 幂等/路径递增分配）
  - [ ] `note_update`/`note_delete`（重命名/快照联动）
  - [ ] `search_query` 完整形状 / folders / graph / meta
  - [ ] canvas / files / experts / review / vault attachments
- [ ] P1-05~07 前端 TS 化
- [ ] P1-08 功能对齐验证（契约快照对照）
- [ ] P1-09 删除 Express 回落
- [ ] P1-10 验收发布 v0.2.0

## IPC 命令核销（契约清单 96 端点）

**已迁移 15 个**（9 vault 既有 + job_list/job_get/job_cancel + tag_list + note_index + note_create）
**剩余 81 个**（含 P3 AI 22 个、P4 MCP 3 个、⛔ 废弃 4 个不在迁移范围）

## 关键问题点（活跃）

- Δ2 folders/UUID 映射：note folderId 暂为 null，随 folders 批次补齐
- Δ3 CI server-test 曾现 flaky（重跑即绿），已加失败 annotation 机制
- Δ4 运行态性能指标（冷启动/内存）待人工采集

## 下一步

1. `note_update`/`note_delete`（乐观锁 + 重命名 + 确认语义）
2. `search_query` 完整形状（notes 模型已就位）
3. folders 表模型迁移 → graph/meta 核销
