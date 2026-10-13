# 格物 Lattice 升级进度看板

> **刷新规则**：每完成一个执行任务立即更新本文件（用户要求）。
> 详细逐节点记录见 [execution-log.md](execution-log.md)；基线数据见 [baseline.md](baseline.md)；契约核销见 [ipc-contract.md](ipc-contract.md)。
> **最后更新**：2026-10-13 ｜ graph_build 完成（links 投影落地，wiki-link 解析对齐 Express）

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
  - [x] `note_update`（乐观锁 409/标题重命名原子 rename/无变化短路）
  - [x] `note_delete`（双确认闸门/文件+投影清理/历史快照保留）
  - [x] `search_query`（strategy 枚举 fts/like/like-fallback + mapRow 形状）
  - [x] `note_history_list/get/restore`（快照哈希完整性校验、恢复走写边界自动快照）
  - [x] links 投影（迁移 006 + wiki-link 解析）+ `graph_build`（nodes/edges/dangling/stats）
  - [ ] folders / meta
  - [ ] canvas / files / experts / review / vault attachments
- [ ] P1-05~07 前端 TS 化
- [ ] P1-08 功能对齐验证（契约快照对照）
- [ ] P1-09 删除 Express 回落
- [ ] P1-10 验收发布 v0.2.0

## IPC 命令核销（契约清单 96 端点）

**已迁移 21 个**（9 vault 既有 + jobs 3 + tag_list + note_index + note CRUD 3 + search_query + history 3）
**剩余 75 个**（含 P3 AI 22 个、P4 MCP 3 个、⛔ 废弃 4 个不在迁移范围）

## 关键问题点（活跃）

- Δ2 folders/UUID 映射：note folderId 暂为 null，随 folders 批次补齐
- Δ3 CI server-test 曾现 flaky（重跑即绿），已加失败 annotation 机制
- Δ4 运行态性能指标（冷启动/内存）待人工采集

## 下一步

1. folders 表模型迁移 → folder_tree/graph/meta 核销（含 links 解析落地）
2. canvas 读写批（canvas_list/read/write/move/delete）
3. folders 写命令批（create/update/delete）
