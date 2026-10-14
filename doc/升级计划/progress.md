# 格物 Lattice 升级进度看板

> **刷新规则**：每完成一个执行任务立即更新本文件（用户要求）。
> 详细逐节点记录见 [execution-log.md](execution-log.md)；基线数据见 [baseline.md](baseline.md)；契约核销见 [ipc-contract.md](ipc-contract.md)。
> **最后更新**：2026-10-14 21:15 ｜ **Δ13 处置推进**：NoteDetail 关系字段（`tags`/`outgoing`/`backlinks`）补齐 + `propertiesJson` 线缆归一，差异清单 **99→80 条**；`note_create`/`note_update`/`note_history_restore` 三条命令**响应结构已完全对齐**

## 本轮变更（2026-10-14）

| 节点 | 状态 | 提交 | 一句话 |
|---|---|---|---|
| P1-07 组件层 TS 化 | ✅ 完成 | `d2a7a9a` | 34 文件 `.jsx`→`.tsx`，strict 错误 1343→0；顺修 1 处既有 bug（Δ12） |
| P1-05 收尾：api 层 invoke 双轨 | ✅ 完成（入口切换暂缓） | `9271e2e` | 映射表 34/58 可对齐，24 条排除并出清单（Δ13） |
| 看板刷新 | ✅ 完成 | `c0e178a` | 三口径拆分 + M1 自查清单 |
| P1-08 第 1 步（前置）：契约一致性校验 | ✅ 完成 | `b678f4c` | 映射表 ↔ Rust 注册表防漂移；修正 1 处落表错误 |
| P1-08 第 1 步（正式）：录制契约快照 | ✅ 完成 | `30e90e0` | 50 case + seed vault + 递归 schema；幂等验证通过；新增 fixtures 自检器 |
| **P1-08 第 2 步：双通道对齐断言** | ✅ 完成 | `6555003` | 静态参数契约（当 34 条路由全覆盖）+ Rust 结构对齐；差异基线 27 命令 / 99 条（**现 26 / 93**，映射表现 35 / 23） |
| **P1-08 第 3 步：消费层一致性断言** | ✅ 完成 | `5585a04` | 50 fixture 双通道回放，交付给 UI 的值逐字节一致；表内 0 静默回落 |
| **Δ13 增量 1：note 系 `properties` 对象** | ✅ 完成 | `2d34ae9` | Rust 补发 `properties` 对象；差异 99→96、回收 `GET /notes/index`（映射表 35/23） |
| **Δ13 增量 2：`note_update` 保留属性** | ✅ 完成 | `af0fa83` | 修 `properties.unwrap_or_default()` 导致改正文即清空 frontmatter 属性的真 bug；差异 96→93 |
| **Δ13 增量 3：NoteDetail 关系字段** | ✅ 完成 | `80977f5` | 先补 fixture 覆盖（原 outgoing/backlinks 全为空数组、元素形状无基准），再按 Express 查询实现 `tags`/`outgoing`/`backlinks`；差异 93→81，2 条命令彻底对齐 |
| **Δ13 增量 4：`propertiesJson` 线缆归一** | ✅ 完成 | `6de9dc0` | 无属性笔记 Express 发 `"{}"` 而 Rust 发 null → 改为线缆层始终发字符串；差异 81→80，`note_create` 彻底对齐 |

> 验证口径：`tsc --noEmit` 0 错 · `npm --prefix web run test` **EXIT=0**（含 154 项集成检查）· `vite build` 通过（1986 modules）

## 总进度（按计划工期加权：29 周基准）

**总体 ≈ 34%**（P0 全部 1 周 + P1 约 9/11 周）

| 阶段 | 工期 | 进度 | 状态 | Gate |
|---|---|---|---|---|
| P0 准备与基线冻结 | 1 周 | 100% | ✅ 完成 | **M0 达成**（CI 四 job 全绿） |
| P1 原生核心与写入边界 | 11 周 | ≈82% | 🔄 进行中 | M1 待达成（仅差 Δ13/Δ14 处置） |
| P2 编辑器投影（BlockSuite） | 5 周 | 0% | ⬜ | M2 |
| P3 AI 本地化与向量索引 | 7 周 | 0% | ⬜ | M3 |
| P4 MCP/插件与发布 | 5 周 | 0% | ⬜ | M4 |

## P1 内部进度

- [x] P1-01 WorkspaceService 统一写入边界（锁/审计/快照/错误模型）
- [x] P1-02 SQLite 恢复/迁移事务化/迁移前备份
- [x] P1-03 watcher reconcile + 持久化 jobs 队列
- [x] P1-04 非 AI 命令面迁移（96 端点中非 AI/MCP 侧 59 个全部实现为 Rust 命令）
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
- [x] **P1-04 非 AI 命令面迁移全部完成**（96 端点中非 AI/MCP 侧 59 个全部实现为 Rust 命令）——但「命令已实现」≠「前端路由可用」，见下方「IPC 命令核销」与 Δ13
- [x] P1-05 api 层 TS 化（12 模块 git mv 转 .ts + 类型标注，零运行时改动；测试 import 改 .ts 后缀走 Node 24 type stripping；tsconfig 开 allowImportingTsExtensions）
- [x] P1-06 hooks/lib TS 化（20 文件 git mv 转 .ts/.tsx + 类型标注；11 个测试 import 改 .ts；顺修类型化揭出的 2 处既有 bug：useToast dedupe 反向清理失效、static-export 索引页 rows.map→notes.map）
- [x] P1-07 components/shell/settings 全量 .jsx → .tsx（34 文件 git mv；**strict 错误 1343→0**：CanvasView 328 / SettingsModal 252 / FolderTree 199 / AIAssistantPanel 175 / EditorPane 167 / ExpertsCenter 118 / ModelCenter 98 / Sidebar 5 / App 1；顺修 1 处既有 bug：McpServerSettings 作用域引用失效（组件内引用不存在的外层 `onConfirmFileOperation`/`vaultPath`，一旦开启项目级 MCP 必抛 ReferenceError）；`test/ai-motion.test.mjs` 源路径 .jsx→.tsx）
- [x] **P1-05 收尾（api 层 invoke 双轨）✅**：`api/ipc.ts`（分发机制）+ `api/ipc-routes.ts`（映射表）+ `client.ts` 单一分发点（置于重试循环之外）；58 条路由逐条审计 → **34 条进表**（31 直接映射 + 3 需适配）、**24 条带行号证据排除**（11 缺命令 / 13 结构不兼容）；错误归一（Rust 裸字符串 → `ApiError(code='IPC_ERROR')`）、信封还原（命令返回 → `{data}`/`{data,meta}`）；`web/test/ipc-dual-track.test.mjs` 13 组断言（含静态优先于动态、args 表达不了则回落、不重试）
- [ ] P1-05 收尾（批次 2 未闭环）：**入口切全功能 App 暂缓**——23 条未映射路由意味着桌面态仍缺功能（见 Δ13），先补齐 Rust 形参/命令再切
- [x] **P1-08 功能对齐验证（契约快照对照）✅ 三步全部完成**
  - [x] **第 1 步（前置）：契约一致性校验 ✅**（`b678f4c`）`web/test/ipc-routes-contract.test.mjs` 解析 `generate_handler!` 并断言：进表命令必已注册、同 method 无重复路由、静态路由必须排在会吞掉它的动态路由之前、进表项与排除项互斥、`IPC_PENDING_COMMANDS` 确实未注册（**排除清单变成可执行断言**：将来实现其中之一会测试失败并提示回收进表）、34 + 24 = 58 口径自洽；顺带**修正 1 处落表错误**（`GET /notes/:id/history` 被误收，实为结构不兼容）；测试另打印「已注册但前端两通道都未引用」的 **18 个命令**作为本步待办视野（`job_list/get/cancel`、`note_index`、`note_create`、`note_update`、`search_query`、`note_history_list/get`、`folder_create/update/delete`、`canvas_list`、`vault_attachment_upload`、`vault_download`、`file_read/find/grep`）
  - [x] **第 1 步（正式）：录制 Express 契约快照 ✅**（`30e90e0`）`src-tauri/tests/tools/record-fixtures.mjs` 起临时 Express + **确定性 seed vault**，驱动 59 个已注册命令中的 **50 个**，产出 `src-tauri/tests/fixtures/`：`cases/<command>.json`（请求 + 响应 data + **由 data 递归推导的 schema** + volatilePaths）、`seed/manifest.json` + `seed/vault/**`（Rust 侧据此重建同一 Vault）、`index.json`（覆盖统计）。归一化保证字节级可复现（时间戳/64-hex/临时路径/耗时 → 占位符；**播种锚点 id 不归一**，供两通道对齐）；**幂等已独立验证**（连续两次运行目录哈希一致 `1e3c7d04…`）。跳过 9 个：7 个 Rust 内部 `vault_*`（Express 无对应端点）+ `job_get`/`job_cancel`（job 仅由 P3 端点创建，无法确定性播种）。另加 `src-tauri/tests/tools/validate-fixtures.mjs`（`npm run verify:fixtures`，已接入根 `verify` 链）守住基准自身：索引与 case 数一致、必需字段齐备、command 与文件名一致、**schema 必须等于由 data 重算的 schema**、无残留未归一时间戳/哈希；**已反向验证**（故意改坏一个 case → exit 1 且精确报出，恢复后归 0）
  - [ ] 第 2 步：Rust 侧逐命令加载 fixture 断言结构/语义一致（注意命令是 crate 私有 `fn`，测试须落在 `src/` 内的 `#[cfg(test)]`，`tests/` 目录调不到）
  - [x] **第 2 步：双通道对齐断言 ✅**（`6555003`）两条腿：
    - **静态参数契约**（`web/test/ipc-args-contract.test.mjs`，已进 web `test` 链）：解析 `lib.rs` 每个 `#[tauri::command]` 形参并转 camelCase，再用**万能 Proxy ctx 实际调用映射表的 `args` 构造器**收集键集合，断言「不多传键 + 必填形参都被提供」——34 条路由全覆盖、0 跳过。这是 invoke 最高频失效模式（参数名漂移）的守门人
    - **运行时结构对齐**（`src-tauri/src/parity_tests.rs`，crate 内 `#[cfg(test)]`；命令经 F2 后是私有 `fn` 且 `with_workspace` 需要 `State`，单测只能测**服务层**）：重建 seed Vault → 按 fixture 时序回放 → 算 schema → 与 Express 逐字段 diff → 与期望清单 `src-tauri/tests/fixtures/divergence.json` 比对。**基线：27 个命令 / 99 条差异**（**现已收缩到 26 / 93**，见 Δ13 处置）。清单**设计成可收缩**：修好一处即失败并点名要删的条目；服务调用统一走 `capture()`，出错记成差异而不是 panic 掉整份基线
  - [x] **第 3 步：消费层一致性断言 ✅**（`5585a04`）`web/test/ipc-parity-consumption.test.mjs`（已进 web `test` 链）——**数据驱动**：把 50 个 fixture 的同一份 `data` 分别经 ①HTTP（fetch 桩返回 `{data}` 信封）与 ②IPC（invoke 桩直接返回数据本身）走一遍 `http.*`，断言两条通道交付给消费层的值逐字节相同（**50/50 一致**）；同时钉住「实际走的通道」——**表内 30 条全部走 invoke、表外 20 条必须回落 HTTP、表内 0 条静默回落**（静默回落是真 hazard：路由匹配上了但 `args` 自述表达不了会回落，而真实桌面端没有 Express 兜底）。另覆盖错误路径：HTTP 400 `{error:{message}}` 与 IPC 抛出同一文案，两条通道的用户可见 message 一致（`code` 不同属已知差异：HTTP 保留服务端 code，IPC 为裸字符串只能标 `IPC_ERROR`）。**反向验证三种破坏全部被拦**：删表内路由 / IPC 侧不套信封（点名 30 个命令）/ 强制 args 返回 undefined（点名静默回落路由）
- [ ] P1-09 删除 Express 回落 ← **当前（前置：Δ13/Δ14 处置）**
- [ ] P1-10 验收发布 v0.2.0

## IPC 命令核销（契约清单 96 端点）

三个**不同口径**的数字，不要混用：

| 口径 | 数字 | 含义 |
|---|---|---|
| 契约端点 | 96 | 冻结清单总量（[ipc-contract.md](ipc-contract.md) §2） |
| 已实现 Rust 命令 | 59 | P1-04 交付（vault 9 + jobs 3 + tag_list + note_index + note CRUD 3 + search_query + history 3 + graph_build + folders 4 + meta_overview + canvas 5 + attachments 8 + files 7 + experts/skills 9 + review 3） |
| 未迁移端点 | 37 | 口径 = 96 − 59（含 P3 AI 22、P4 MCP 3、⛔ 废弃 4、及其余 ⬜；⬜ 与 ⛔ 的归类存在重叠，P1-08 时校准） |

**双轨映射核销（P1-05 收尾）**——前端 api 层 81 个 `http.*` 调用点归并出 **58 条非 AI/MCP 路由**，逐条比对入参与返回结构（注意：58 是「前端路由数」，与上面的「端点数」不同口径）：

| 结论 | 条数 | 处理 |
|---|---|---|
| 直接映射 | 31 | 进 `ipc-routes.ts`，参数与返回均对齐 |
| 需适配映射 | 3 | 进表：`PUT /canvas` 拆 `nodes`/`edges`；`/files/preview`、`/files/execute` 的 `action`/`actions` 二态 |
| 缺命令 | 11 | 契约 ⬜ 的 10 条 + ⛔ 的 `/health`，不阻塞（回落 HTTP） |
| **结构不兼容** | **13** | 命令存在但入参/返回对不上，**接上去会静默改行为**——明细见 Δ13 |

**权威清单**：`web/src/api/ipc-routes.ts`（进表项 + 末尾「排除清单」，逐条带行号证据）；契约侧见 [ipc-contract.md](ipc-contract.md) §5「双轨映射核销」

## 关键问题点（活跃）

- ~~Δ2 folders/UUID 映射~~：已解决（迁移 007 + 确定性目录 id）；已知限制：目录改名后确定性 id 变化（用户排序 sortOrder 特性延后，见 progress 下一步）
- Δ3 CI server-test 曾现 flaky（重跑即绿），已加失败 annotation 机制 → **已定位疑似成因**：`vault-attachments.test.js` 的符号链接用例是否执行取决于本机 `fs.symlink` 能否成功，见 Δ10
- Δ4 运行态性能指标（冷启动/内存）待人工采集
- **Δ10（新增）** 本机 `server-test` 194→193 失败 1 项：`server/test/vault-attachments.test.js:86`「符号链接指向点目录的下载应 404，实得 200」，3/3 确定性复现；经核验本轮两笔提交（`d2a7a9a` P1-07 / `9271e2e` P1-05 收尾）**0 个 server 文件**，改动全在 `web/` 与 `doc/`，`server/` 工作区干净、最近一次服务端改动早于 P1 全部批次 → 属**预先存在**的环境相关用例（Windows realpath/符号链接语义），非本次引入。CI 跑 ubuntu-latest 不受影响；建议 P1-08 一并核对 Rust `vault_download` 的符号链接/点目录语义后再定 M1 门禁口径
- **Δ11（新增）** 类型化过程中揭出 api 契约层类型过宽（不在 P1-07 改动范围，登记给 P1-08 校准）：`resources.ts` 的 `notesApi.history` 标为 `unknown[]`、`notesApi.historyVersion` 返回 `unknown`、`NoteDetail` 缺 `filePath`；`vault-files.ts` 的 `LatticeDesktopBridge` 缺 `revealVault`/`backupVault`/`exportStaticSite`，`vaultAttachmentsApi.upload` 条目缺 `mimeType`；`canvas.ts` 的 `CanvasDocument.nodes/edges` 为 `unknown[]`。当前以组件侧局部类型 + `as` 断言消化（全仓 `as unknown as` 仅 16 处、`: any` 29 处）
- **Δ13（新增，M1 前必做）**「已有 59 个 command」≠「前端 58 条路由都能走 IPC」：审计时只有 **34 条**可对齐、**24 条排除**（13 条结构不兼容），**截至 `2d34ae9` 已回收 1 条 → 35 / 23**（`GET /notes/index`：Rust 补发 `properties` 对象后完全对齐）：
  - 参数缺失：`note_create`/`note_update` 无 `folderId`（新建到目录、移动笔记无法表达）；`search_query` 无 `folderId`/`inboxStatus`；`folder_create`/`folder_update` 收**父目录路径**而前端传 `parentId`；`vault_attachment_upload` 无 `folder`
  - 返回结构不符：~~`note_index` 发 `propertiesJson`(string) 而前端当对象用~~ **已修**（`2d34ae9`，Rust 同发 `properties` 对象）；`notes/:id/history` 前端要 `{items,currentHash}`、命令发数组；`history/:version` 前端要 `{version,createdAt,title,content,isPinned,properties}`、命令只给 `{version,raw,hash}`；`canvas_list` 发 `Vec<String>` 而前端要 `path/name/folderPath` 对象；`vault_info` 只回 `{path}` 而前端读 `vaultDir`+`profile`；`vault_download` 发 base64 JSON 而前端直接 `fetch+blob`
  - 语义差异：`folder_delete` 对非空目录返回 CONFLICT 拒绝，Express 语义是「笔记移到未分类」；前端读的 `affectedNoteCount` 命令也没有
  - **结论**：入口切全功能 App 必须先补齐这些（尤其 note 系 `propertiesJson`↔`properties` 与 `folderId` 形参），否则桌面态会静默丢功能。完整清单与行号证据见 `web/src/api/ipc-routes.ts` 文件末尾「排除清单」
  - **处置进展**：`2d34ae9` 修掉 note 系 `properties` 共性缺口并回收 `/notes/index`（差异 99→96）；`af0fa83` 修掉 `note_update` 改正文即清空 frontmatter 属性的真 bug（差异 96→93）。**当前 23 命令 / 80 条**
- 其余仍挂着的：Δ5 契约「第二人抽查 10 项」单人环境无法满足 · Δ6 远端 main 落后 v0.1.5（待 Gate Review 后合回）· Δ7 gh CLI 不可用（CI 由 push 触发）· Δ9 experts/skills 内置资源仍 `include_str` 自 `server/`，**P1-09 删 Express 前必须迁到 src-tauri**（Δ1/Δ8 已解决，全量清单见 [execution-log.md](execution-log.md)）
- **Δ14（新增，待产品决策）** `vault_read_asset` 的白名单与 Express **刻意不同**：Rust 只认 png/jpg/jpeg/gif/webp（并显式拒绝 SVG），Express 的 `/api/vault/attachment` 能返回任意白名单附件（fixture 用的就是 `.txt`）。**这条差异已如实记入 `divergence.json`（唯一一条 `error` 类），没有去改 Rust**。原因：曾把 `read_asset` 改成复用全量白名单（`vault_file_mime`），结果打破既存测试 `vault::tests::attachments_are_limited_to_safe_image_files`（断言 `read_asset("attachments/test.svg").is_err()`），而契约 §5.2/§1 也写明 SVG 必须强制 attachment 防 XSS——**这是有意为之的安全姿态，不能为了让 parity 变绿而放宽**。需在 P1-08 定夺：是保持 Rust 的窄白名单（则契约需注明桌面态不支持内联预览非图片附件），还是放宽并同步补 XSS 防护（例如仅允许非可执行类型、SVG 走 `<img>` 且禁脚本）。判定依据可参考：SVG 作为 `<img src="data:...">` 通常不可执行脚本，但作为导航/内联文档可以

## M1 达成条件（P1 收口自查）

- [x] P1-08 第 1 步：契约快照基线（50 case）+ fixtures 自检器（`npm run verify:fixtures`）
- [x] P1-08 第 2 步：双通道对齐断言（静态参数契约 + Rust 结构对齐，差异清单已从 27 命令 / 99 条收缩到 **23 / 80**）
- [x] P1-08 第 3 步：消费层一致性断言（50 fixture 双通道回放，值逐字节一致；表内 0 静默回落）
- [ ] **Δ13 补齐**：至少 note 系 `propertiesJson`↔`properties` 与 `folderId` 形参、folder 系 id 寻址；补齐前**不得**把桌面入口切到全功能 App（计划 §5.3-5 的顺序约束）
- [ ] **Δ14 定夺**：`vault_read_asset` 白名单口径（保持窄白名单并写进契约，或放宽并补 XSS 防护）
- [ ] Δ11 api 契约类型收紧（去掉组件侧 `as unknown as` / `: any` 断言）
- [ ] Δ10 server-test 基线重采，并写明「本机符号链接可创建」这一口径
- [ ] Δ9 builtin 资源迁出 `server/`（P1-09 前置）
- [ ] Δ4 运行态指标人工采集（冷启动/首屏/内存）

## 下一步

1. **Δ13 处置（M1 前必做，主战场）**：按 `ipc-routes.ts` 排除清单 + `divergence.json` 的 **80 条**差异继续补 Rust——建议顺序：①~~NoteDetail 补 `tags`/`outgoing`/`backlinks`~~ ✅（`80977f5`）②**note 系 `folderId` 形参**（打通新建到目录 / 移动笔记，也是 `POST /notes`、`PATCH /notes/:id` 两条路由能否回收的关键）③folder 系 id 寻址与 `affectedNoteCount`（7 条）④`canvas_list` 返回对象（4 条）⑤`vault_info` 补 `vaultDir`/`profile`（7 条）⑥补 10 个 ⬜ 命令 ⑦**扩展 harness 的数组比对**（现仅采样首元素，会漏掉后续元素的类型问题）
2. **Δ14 定夺**：`vault_read_asset` 白名单口径（需产品/安全拍板，不是纯技术选择）
3. Δ11 收紧 api 契约类型；Δ10 复核 Rust `vault_download` 对符号链接/点目录的返回码
4. **待对齐项**：Express 对行首 `#标签` 有 heading 启发式（会被当标题吃掉），播种须内联；Rust 标签解析口径需核对
5. Δ13/Δ14 清零且 `divergence.json` 收缩到可接受范围后，才进入 **P1-09 删除 Express 回落**（计划 §5.3-5 顺序约束）
