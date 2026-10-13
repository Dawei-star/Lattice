# 格物 Lattice 升级基线档案（P0-3）

> **基准 tag**：`v0.1.5-baseline`（提交 `a26ab8d`，分支 v0.1.5，2026-10-13）
> **用途**：P1-P4 性能验收对照基线（计划 §4.2 P0-3、§8.2 P4-07）
> **测量环境**：Windows 11 x64 · Node 24.12.0 · npm 11.6.2 · Rust 1.99.0（stable-x86_64-pc-windows-gnu）· 本机执行

## 1. 门禁测试基线（P0-1，全绿）

| 门禁 | 命令 | 结果 |
|---|---|---|
| server 测试 | `npm --prefix server run test` | **194/194 通过**（16.3s，6 suites） |
| web 测试 | `npm --prefix web run test` | **全绿**（22 个测试文件 + 集成测试，exit 0） |
| Rust 测试 | `cargo test --release` | **17/17 通过**（P0-6 后；基线初测 14 项中 1 项失败已修复，见 §4） |
| Rust lint | `cargo clippy -- -D warnings` | **通过**（0 warning） |
| TS 检查 | `npm --prefix web run typecheck` | **通过**（tsc --noEmit） |

## 2. 包体基线

| 产物 | 体积 |
|---|---|
| Windows MSI（`Lattice_0.1.5_x64_en-US.msi`） | **9.38 MB** |
| Windows NSIS（`Lattice_0.1.5_x64-setup.exe`） | **7.05 MB** |
| web 构建产物 `web/dist/`（合计） | 6.25 MB（其中 `liquid-glass-bg.png` 占 1.3MB；.map 文件随后续构建配置可评估剔除） |

## 3. 性能基线

### 3.1 全文检索延迟（FTS5 trigram，中文子串查询，300 次采样）

> 测量口径：`node:sqlite` 内存库，schema/触发器/trigram 分词器与 Rust 侧 `db.rs MIGRATION_001` 一致（rusqlite bundled 同源 SQLite），排除磁盘 IO；**生产路径含磁盘读放与进程调度，实际值应高于此下界**。

| Vault 规模 | P50 | P95 | P99 |
|---|---|---|---|
| 500 篇（约 1KB/篇中文） | 0.03 ms | **0.09 ms** | 0.23 ms |
| 10,000 篇 | 0.15 ms | **0.28 ms** | 0.39 ms |

### 3.2 运行态指标（待人工采集，M0 遗留项）

以下指标需在桌面应用运行态采集，自动化环境无法替代：

| 指标 | 状态 | 采集方法建议 |
|---|---|---|
| 冷启动时间（双击到首屏可交互） | ⬜ 待测 | 手表计时或系统日志；按 500/10,000 篇 Vault 各测 3 次取中位 |
| 首屏渲染时间（与完整索引分离测量） | ⬜ 待测 | DevTools Performance（dev 构建近似） |
| 完整索引延迟（10,000 篇） | ⬜ 待测 | `vault_scan` 前后时间差 |
| 空闲内存 | ⬜ 待测 | 任务管理器/Process Explorer |
| 真实库磁盘搜索 P95 | ⬜ 待测 | 对 §3.1 的内存库口径补充磁盘库对照 |
| AI 问答 TTFT | ⬜ 待测 | P3 接入本地 provider 后采集（对照 §P3） |

## 4. 基线修复记录（P0 期间为使基线全绿的最小修复）

> 偏差说明：计划 §2.1 声称"Tauri 壳可编译出 release 产物"，实测基线不成立——src-tauri 处于中途编辑未编译通过状态。为满足 M0"全量测试绿"，执行了以下**最小修复**（不改变行为语义）：

| # | 问题 | 修复 | 位置 |
|---|---|---|---|
| F1 | `Workspace::open` 对 `io::Result` 直接用 `?` 转 `String`（E0277） | 补 `.map_err(\|e\| e.to_string())` | `src-tauri/src/lib.rs` |
| F2 | crate 根模块 `pub fn` 命令触发 `#[macro_export]`+`pub use` 重复定义（18×E0255，tauri-macros 2.7.2 展开机制） | 9 个命令改为 crate 私有 `fn`（仅同 crate `generate_handler` 引用，IPC 命令名不变） | `src-tauri/src/lib.rs` |
| F3 | 迁移测试用 2 字符查询 MATCH trigram 索引（trigram 要求 ≥3 字符，必 0 命中） | 改用 3 字符 `"学习笔"` 并注明短查询由 index 层 LIKE 回退负责 | `src-tauri/src/db.rs` |
| F4 | 4 处 P1-04 接线目标触发 dead_code 警告（阻塞 clippy 门禁） | `#[allow(dead_code)]` + 注记接线阶段 | vault.rs / index.rs |
| F5 | 迁移无事务：失败会留下半套 schema 且 user_version 已提升 | 迁移事务化（失败整体回滚、user_version 不提升、错误注明可重试）+ 3 个恢复测试 | `src-tauri/src/db.rs`（P0-6） |

## 5. 环境与依赖锁定基线

| 项 | 版本 | 备注 |
|---|---|---|
| tauri / tauri-build / tauri-macros | 2.12.3 / 2.7.2 / 2.7.2 | Cargo.lock 锁定 |
| rusqlite | 0.40（bundled，自带 FTS5+trigram） | 零外部依赖 |
| BlockSuite | ^0.19.5 已安装未接线 | P2 启用 |
| marked | ^14.1.4 在役 | P2 替换 |
| React / Zustand / TS | 18.3 / ^5.0.15 / 5.9.3 | — |
| Node engines | root ≥22.5 / server ≥22.9 | 实测 24.12 全绿 |
| rust-version | 1.90（Cargo.toml） | 实测 1.99 全绿 |
