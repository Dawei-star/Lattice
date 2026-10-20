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

#### 3.2.1 本机过程级补充采样（2026-10-15）

> 口径限制：使用 Windows release `lattice.exe`，通过 `LATTICE_VAULT_DIR` 指向临时 Vault；`WindowReadyMs` 是进程主窗口句柄出现时间，不等于首屏可交互时间；工作集为窗口出现后等待 5/8 秒的单次采样，不是稳定空闲内存基线。该数据用于问题记录和后续人工复核，不能替代三次中位数验收。

| Vault 规模 | 文件数 | WindowReadyMs | 工作集采样 | SQLite | TCP 监听 |
|---|---:|---:|---:|---|---:|
| 500 篇 | 500 | 2,000 ms | 44.98 MiB（等待 5 秒） | 已创建 | 0 |
| 10,000 篇 | 10,000 | 525 ms | 45.14 MiB（等待 8 秒） | 已创建 | 0 |

> 两组均为单次过程采样，受 Windows 文件缓存、桌面加载状态和测试机负载影响；未将其标记为冷/热启动、首屏或完整索引验收结果。

#### 3.2.2 Windows P1-10 隔离 Vault 三次采样（2026-10-15）

> 采样脚本：[`scripts/windows-p1-10-runtime-sample.ps1`](../../scripts/windows-p1-10-runtime-sample.ps1)；原始结果：[`windows-p1-10-runtime-sample.json`](windows-p1-10-runtime-sample.json)。每个规模执行 3 次冷启动（新建临时 Vault）和 3 次热启动（同一临时 Vault 完成一次索引后重启）。`indexCompleteMs` 是 SQLite `notes` 行数达到生成文件数的过程指标，不是首屏可交互时间；`windowReadyMs` 是主窗口句柄出现时间。所有样本索引数量正确，Lattice 进程 TCP 监听均为 0。

| Vault | 模式 | indexCompleteMs 三次 | 中位数 | 工作集范围 | 结论 |
|---|---|---:|---:|---:|---|
| 500 篇 | 冷启动 | 2,746 / 3,680 / 4,116 ms | 3,680 ms | 33.3–75.3 MiB | 过程采样完成 |
| 500 篇 | 热启动 | 839 / 1,451 / 1,523 ms | 1,451 ms | 31.5–31.7 MiB | 过程采样完成 |
| 10,000 篇 | 冷启动 | 17,014 / 29,376 / 77,430 ms | 29,376 ms | 35.9–36.3 MiB | **波动显著，待负责人确认** |
| 10,000 篇 | 热启动 | 495 / 1,814 / 1,822 ms | 1,814 ms | 33.6–33.7 MiB | 过程采样完成 |

> 该采样补齐了按规模/冷热状态的三次过程数据，但仍不能关闭人工验收：首屏可交互、真实库磁盘搜索 P95 和发布负责人签字尚未完成。10,000 篇冷启动最大值 77.430 秒已登记为异常观察，不得以中位数掩盖。

#### 3.2.3 10,000 篇冷启动低频探针复测（2026-10-15）

> 为排除高频外部 SQLite 轮询对索引任务的干扰，复测将索引状态探针降为最多每秒一次，原始结果见 [`windows-p1-10-runtime-recheck.json`](windows-p1-10-runtime-recheck.json)。冷启动 3 次为 **16,663 / 34,081 / 41,011 ms**，热启动 3 次为 **792 / 1,180 / 2,168 ms**。未复现 77.430 秒，但冷启动仍出现 41.011 秒长尾；该结果支持“Windows 冷索引存在显著波动”的观察，不能据此判定性能达标。

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

## 6. P1-09/P1-10 当前核验记录（2026-10-15）

| 门禁 | 结果 |
|---|---|
| Rust 单元测试（`src-tauri`） | **75/75 通过**（`cargo test --lib`） |
| Rust clippy | **通过**（`cargo clippy --lib -- -D warnings`） |
| Web TypeScript | **通过**（`npm --prefix web run typecheck`） |
| Web 生产构建 | **通过**（Vite 1978 modules） |
| Web 全量契约测试 | **通过**；IPC 映射 57 条、设计性排除 1 条、50 个 fixture 消费层对齐 |
| 版本一致性 | 根、Web、Cargo、Tauri 配置及 lockfile 均为 `0.2.0` |
| Windows 桌面安装包 | **通过**：MSI `10.13 MiB`，NSIS `7.56 MiB`，产物版本 `0.2.0` |
| macOS/Linux 安装包 | 本机未执行；`.github/workflows/upgrade-gate.yml` 已加入三平台 `desktop-build` 矩阵，待 CI 记录真实结果 |

删除 Express 后，依赖 `server/src/index.js` 的旧 HTTP 集成测试不再属于桌面版测试链；P1/P3 契约快照和 Rust parity 夹具继续保留。
