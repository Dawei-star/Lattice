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
| P1-04 非 AI 命令面迁移 | 🔄 进行中 | 批次1 tags ✅（`ad945df`）；批次2 notes 模型+`note_create` ✅（`0480386`/`9622709`）；批次3 `note_update`/`note_delete`/`search_query`/links 投影/`graph_build`/`folder_tree`+folders 写命令 ✅（`d2095cc`/`723c60a`/`bb54c1e` 等）；批次4 canvas 5 命令 ✅（`97cc2b6`）；批次5 attachments 核心 4 ✅（`fa76534`）；**批次6 attachments 剩余 4 ✅（本次：`vault_files_list`/`vault_attachment_validate`/`vault_attachment_cleanup`/`vault_download`，50 项 cargo 测试 + clippy -D warnings + 前端契约全绿）**。批次6 偏差与修复：① files 排序按码点（Express 为 zh-CN locale），P1-08 契约对齐时校准；② cleanup 在非 dryRun 删除后补空目录清理（Express 无此行为，属增强）；③ `vault_download` 为新增命令（契约原记 `vault_read_asset` 已更正）；④ 顺带修复批次2 潜伏 bug——`find_note_detail` 列序映射 path/is_pinned 错位导致 found-row 必报错（此前无测试覆盖该路径），新增回归测试常驻；⑤ 根治测试环境 0xC0000139（见 Δ8）。**批次7 files 全套 7 ✅（本次：`file_read`/`file_find`/`file_grep`/`file_preview`/`file_execute`/`file_undo`/`file_log`，语义对齐 scripts/fc-core.mjs——字符切片读取、glob/正则大小写不敏感检索、preview planHash（sha256，Rust 内闭环）→ execute 三重确认闸门 → .fc/trash 快照 → 原子落盘 → .fc/audit.jsonl 审计 → undo 状态校验逆序还原；55 项 cargo 测试 + clippy -D warnings + 前端契约全绿）。批次7 偏差：files 列表排序按码点（Express locale）、read 按 Unicode 码点切片（JS 为 UTF-16 码元，BMP 一致）、find/grep 同时隐藏 .fc 与 .lattice（Express 仅 .fc）、批量失败透传失败消息（Express BATCH_PARTIAL_FAILURE details 在 HTTP 层同样不透出）。**批次8a experts/skills 全套 9 ✅（本次：`expert_list/get/save/delete/route` + `skill_list/get/save/delete`，对齐 experts.registry.js——内置 7 专家 + 9 技能以 include_str 编译期嵌入（Δ9：P1-09 删 Express 前需把 builtin 资源迁至 src-tauri），工作区层 `.lattice/experts/*.json` 与 `.lattice/skills/<id>/{skill.json,SKILL.md}`，workspace 覆盖 builtin 视图；保存/删除走 confirmed（删除另需 secondConfirmed），route 按 ceil(threshold×2) 关键词命中过滤、score=命中×100+priority 截 3；59 项 cargo 测试 + clippy -D warnings + 前端契约全绿）。**批次8b review 3 ✅（本次：`review_health`/`review_plan`/`review_execute`，对齐 knowledge-health.service.js——9 类线索扫描（inbox/brokenLinks/isolated/stale/duplicates/conflicts/metadata/taxonomy/incomplete）+ 健康分，修复计划内存态 TTL 15 分钟 + planHash + 执行前 contentHash 重校验；metadata source 补全/taxonomy 归一/duplicates 完全重复删除走自动修复，其余进 manual；61 项 cargo 测试 + clippy -D warnings + 前端契约全绿）。批次8b 偏差：finding id 用 sha256 截 12 位（Express sha1，仅 id 稳定性语义）、文本归一不做 NFKC、tag-alias 正文替换为朴素字符串替换（regex 无 lookbehind）、duplicates 删除不做 backlink 迁移（note_delete 无 replacementId，P1-08 校准）。**P1-04 非 AI 命令面迁移至此全部完成。** | 见各批次提交 |
| P1-05~07 前端 TS 化 | 🔄 进行中 | **P1-05 api 层 TS 化 ✅（2026-10-14：api/ 12 模块全部 git mv 转 .ts + 类型标注，零运行时改动；新增 ~55 个 interface/type；依赖方 import 后缀 .js→.ts（src 14 处 + test 3 处，Node 24 type stripping 直接跑 .ts）；tsconfig 开 allowImportingTsExtensions；typecheck strict 全绿 + web 全量测试通过含 154 项集成检查）**。**P1-06 hooks/lib TS 化 ✅（2026-10-14：hooks/ 4 + lib/ 16 共 20 文件 git mv 转 .ts/.tsx + 完整类型标注（可擦除语法，无 enum/namespace）；11 个测试 import 改 .ts 后缀；strict typecheck 首轮 37 错全修；typecheck + web 全量测试绿）**。类型化揭出并修复 2 处既有 bug（P1-08 复核）：① useToast dismiss 后 dedupeKeys 反向清理用 number id 查 string 键永 miss，同键 toast 关闭后无法再弹出；② static-export 索引页 rows.map 应为 notes.map（链接 href 渲染为空）。**P1-07 components/shell/settings 全量 .jsx→.tsx ✅（2026-10-14：34 个文件 git mv 转 .tsx/.ts（components 24 + settings 7 + shell 3 + ui 4，其中 ui/shell 与部分 components 已在上一轮随 P1-06 收尾）；strict 类型错误 1343→0，按文件：CanvasView 328 / SettingsModal 252 / FolderTree 199 / AIAssistantPanel 175 / EditorPane 167 / ExpertsCenter 118 / ModelCenter 98 / Sidebar 5 / App 1）。方法：`npx tsc --noEmit` 逐文件清零，只补类型（props interface、useState/useRef 显式泛型、回调参数事件类型），零运行时改动；错误主因是 `useState([])/useState(null)/useRef()` 被推断为 never 后属性访问连锁报错（410×TS2339）+ 710×隐式 any。验证：`tsc --noEmit` 0 错 · `npm --prefix web run test` 全绿（含 154 项集成检查）· `vite build` 通过（1984 modules）。顺修类型化揭出的 1 处既有 bug（见 Δ12）。**待办：P1-05 收尾（api 层 invoke 双轨 + 入口切全功能 App）——批次 2 未闭环** | 本次提交 |
| P1-05 收尾：api 层 invoke 双轨 | ✅ 完成（入口切换按决策暂缓） | 新增 `web/src/api/ipc.ts`（分发机制：按注册序匹配路由、动态段 decode、args 返回 `undefined` 即回落、错误归一 `IpcError`）+ `ipc-routes.ts`（映射表）+ `client.ts` 单一分发点（`requestRaw` 内、**重试循环之外**，非桌面/未映射/表达不了即回落 HTTP，api 业务模块零改动）。**58 条路由逐条审计：34 条进表**（31 直接映射 + 3 需适配：PUT /canvas 拆 nodes/edges、/files/preview|execute 的 action/actions 二态），**24 条排除**（11 缺命令 + 13 结构不兼容，见 Δ13）。错误轨：Rust `Result<T,String>` 裸字符串 → `ApiError(code='IPC_ERROR', status=0)`；信封：命令返回值包装回 `{data}`/`{data,meta}` 保持 `get`/`getFull` 语义。新增 `web/test/ipc-dual-track.test.mjs` **13 组断言**（非桌面全走 HTTP、静态优先于动态、动态段 decode、DELETE body 确认参数、args 表达不了回落、缺命令回落、信封还原、canvas_write 拆参且不多带键、action/actions 二态、cleanup 显式回传 dryRun、必填缺失回落、错误归一且不重试）。验证：`tsc --noEmit` 0 错 · `npm --prefix web run test` 全绿（含 154 项集成检查）· `vite build` 通过（1986 modules，主 chunk 447→454 kB / gzip +1.96 kB） | 本次提交 |
| P1-08 功能对齐验证 | 🔄 进行中 | **第 1 步（前置）契约一致性校验 ✅（`b678f4c`）**：新增 `web/test/ipc-routes-contract.test.mjs`——解析 `lib.rs` 的 `generate_handler!`，断言①进表项引用的命令必已注册（防「command not found」类运行时错）②同 method 下无重复路由且**静态路由必须排在会吞掉它的动态路由之前**③进表项与排除项互斥④`IPC_PENDING_COMMANDS` 确实未注册（把排除清单变成**可执行断言**：将来实现其一即测试失败并提示回收）⑤进表 34 + 排除 24 = 58 口径自洽。`ipc-routes.ts` 导出 `IPC_PENDING_COMMANDS` / `IPC_EXCLUDED_ROUTES` 作为机器可读形态。**顺带修正 1 处落表错误**：`GET /notes/:id/history` 同时出现在进表项与排除清单——审计判定其为结构不兼容（命令回 `HistoryEntry` 数组而 `EditorPane` 读 `result.items`），已从表中移除。测试另打印「已注册但前端两通道都未引用」的 **18 个命令**作为本步待办视野（`job_list/get/cancel`、`note_index`、`note_create`、`note_update`、`search_query`、`note_history_list/get`、`folder_create/update/delete`、`canvas_list`、`vault_attachment_upload`、`vault_download`、`file_read/find/grep`）。**实现形态注意**：命令经 F2 修复后是 crate 私有 `fn`，故第 2 步的 Rust 断言须落在 `src/` 内的 `#[cfg(test)]`，`tests/` 目录调不到命令。**第 1 步（正式）录制 fixtures、第 2 步 Rust 断言、第 3 步前端 mock invoke 均待办** | `b678f4c` |
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
| Δ8 | Windows 测试二进制启动即崩 0xC0000139（STATUS_ENTRYPOINT_NOT_FOUND）：tauri 对话框链静态导入 `comctl32!TaskDialogIndirect`，该符号仅由 Common-Controls v6（WinSxS 程序集）导出；tauri-build 只把含 v6 依赖的清单链接进 bins（`cargo:rustc-link-arg-bins`），测试目标仍用 Rust 默认清单（无 v6 依赖），进程加载阶段解析导入失败 | 已解决 | build.rs 以 `WindowsAttributes::new_without_app_manifest()` 接管清单生成，自建 manifest.rc（与 tauri 默认清单同内容）经 `embed_resource::compile_for_everything` 链接进所有目标（bins/tests/examples/benches）；最小 C 复现 + cargo test 双重验证。CI rust-test 在 windows-latest 跑 `cargo test --release`，合并时必遇同问题，此修复为前置保护。TaskDialogIndirect 静态导入的出现时机未完全定论（System32 comctl32.dll 自 2026/5 未变，疑似 10/13 工具链更新后 mingw 导入库/链接行为变化引入，记录为关联性观察） |
| Δ9 | experts/skills 内置资源（7 专家 JSON + 9 技能目录）暂以 include_str 引用 `server/src/modules/experts/builtin/`（编译期嵌入二进制） | ⚠️ 待迁移 | P1-09 删除 Express 前必须把 builtin 资源复制到 src-tauri 并更新 include_str 路径（届时需用户确认新建资源文件） |
| Δ10 | 本机 `npm --prefix server run test` 194→193（fail 1）：`server/test/vault-attachments.test.js:86` 断言「指向点目录的符号链接下载应 404」，实得 200；3/3 确定性复现。核验：P1-07 提交 44 个变更文件全部在 `web/`，`server/` 工作区干净，`git log -- server/src/modules/vault/` 最近改动早于 P1 全部批次 → **预先存在**、非本次引入。成因指向本机 `fs.symlink` 可成功创建（Windows 下与开发者模式/权限相关），使该断言从「跳过」变为「执行」；与 Δ3 的 server-test 抖动同源，本次首次定位到触发条件 | ⚠️ 待复核（非阻塞 P1-07） | 1) CI 跑 ubuntu-latest，不受本机 Windows 语义影响；2) P1-08 核对 Rust `vault_download` 对符号链接 / 点目录的返回码与 Express 一致；3) M1 门禁前在本机重采 server-test 基线（口径需注明「symlink 可创建」条件） |
| Δ11 | api 契约层类型过宽（P1-07 类型化时暴露，未在本次修改范围）：`resources.ts` `notesApi.history` 为 `unknown[]`、`historyVersion` 返回 `unknown`、`NoteDetail` 缺 `filePath`；`vault-files.ts` `LatticeDesktopBridge` 缺 `revealVault`/`backupVault`/`exportStaticSite`、`vaultAttachmentsApi.upload` 条目缺 `mimeType`；`canvas.ts` `CanvasDocument.nodes/edges` 为 `unknown[]` | ⚠️ 待收紧 | P1-08 契约对齐时按真实响应结构补齐 api 层类型，去掉组件侧现有的局部类型 + `as unknown as` 断言（当前全仓 `as unknown as` 16 处、`: any` 29 处，均在 api 边界） |
| Δ12 | `SettingsModal.tsx` 中 `McpServerSettings()` 以无参函数定义（调用处 `<McpServerSettings />`），但函数体引用了外层 SettingsModal 作用域的 `onConfirmFileOperation` / `vaultPath` → tsc TS2304；JS 运行时一旦用户开启「项目级 MCP」会抛 ReferenceError | 已解决 | P1-07 顺修：为 McpServerSettings 增加这两个 props 并在调用点传入（把原本必崩路径修正为正常渲染）。与 P1-06 的 2 处顺修同类（类型化揭出既有 bug） |
| Δ13 | **「59 个 Rust 命令已迁移」≠「前端 58 条路由都能走 IPC」**：双轨审计后 58 条中仅 34 条可对齐，24 条排除，其中 13 条为**结构不兼容**（命令存在但接上去会静默改变行为，比缺命令更危险）。参数缺失：`note_create`/`note_update` 无 `folderId`（新建到目录/移动笔记无从表达）、`search_query` 无 `folderId`/`inboxStatus`、`folder_create`/`folder_update` 收父目录**路径**而前端传 `parentId`、`vault_attachment_upload` 无 `folder`。返回不符：`note_index` 发 `propertiesJson`(string) 而前端当对象消费（App.tsx:367、AIAssistantPanel.tsx:900/904）、`GET /notes/:id/history` 前端要 `{items,currentHash}` 而命令发数组、`history/:version` 前端要 `{version,createdAt,title,content,isPinned,properties}` 而命令只给 `{version,raw,hash}`、`canvas_list` 发 `Vec<String>` 而前端要对象、`vault_info` 只回 `{path}` 而前端读 `vaultDir`+`profile`。语义差异：`folder_delete` 对非空目录 CONFLICT 拒绝（Express 是「笔记移到未分类」），且缺前端读的 `affectedNoteCount`。另有 11 条缺命令（`note_list`/`note_get`/`note_duplicate`/`vault_profile_set`/`vault_migrate_sqlite`/`vault_assets_list`/`note_templates_list`/`note_create_from_template`/`note_create_daily`/`tag_delete`，及 ⛔ 的 `/health`） | ⚠️ M1 前必做 | 完整清单 + 行号证据见 `web/src/api/ipc-routes.ts` 末尾「排除清单」。**在补齐前不得把桌面入口切到全功能 App**（计划 §5.3-5 的顺序约束在此处获得实证依据）；建议 P1-08 先补 note 系 `propertiesJson`↔`properties` 与 `folderId` 形参、folder 系 id 寻址 |

## 回滚与数据安全（要求 #4 核验）

- 基线 tag `v0.1.5-baseline` 可随时回退（`git checkout v0.1.5-baseline`）
- P0/P1 变更均不触碰 Vault 用户数据（.md/.canvas/附件零改动，不变量 I9）
- SQLite 迁移事务化 + 迁移前备份 + WAL 自恢复测试常驻（I8）
- Express 双通道仍完整在役（P1-09 前不删除），桌面 IPC 与 HTTP 回落并存
