# 格物 Lattice IPC 契约清单（P0-4）

> **依据**：升级计划 v1.1 §4.2 P0-4 ｜ **盘点基准**：v0.1.5-baseline tag（提交 `a26ab8d`）
> **盘点方式**：以代码为准逐端点核实（`server/src/app.js` + `server/src/routes/index.js` 逐模块清点），非凭记忆列举
> **核销规则**：P1-04/P1-08 按"状态"列逐项核销；命令签名变更必须同步三处（Rust 命令、TS 封装、契约测试），否则 CI 拦截（计划 §10.2/§12）
> **配套**：[lattice-upgrade-plan.md](lattice-upgrade-plan.md) ｜ [baseline.md](baseline.md)

## 0. 冻结的数据不变量（P0-5）

以下不变量自本清单定稿起冻结，任何阶段的实现不得违背；Gate Review 逐条对照（计划 §12.5）：

| # | 不变量 | 说明 |
|---|---|---|
| I1 | Markdown/.canvas/附件是唯一持久化真源 | SQLite 索引、向量、链接图全部是可重建投影 |
| I2 | 投影必须携带 source hash | 笔记/画布写入经内容哈希乐观锁（expectedHash→409） |
| I3 | 链接解析以标题/路径为键 | `links` 表可由全库扫描重建 |
| I4 | 模型/解析器版本可追踪 | embedding 记 model_id/version/dimensions/chunker_version（P3 落地） |
| I5 | 任务可恢复 | 后台任务持久化（queued/running/completed/failed/cancelled），崩溃后可重试 |
| I6 | 写入可审计、可撤销 | AI 写入审计链路 + files 操作日志/undo 不得绕过 |
| I7 | 单实例写入 | Vault 单实例锁；所有写入（UI/AI/MCP/插件/watcher）经 WorkspaceService |
| I8 | 禁止删除 WAL/SHM | 启动只让 SQLite 自恢复；CI 常驻恢复测试 |
| I9 | 用户数据零损失 | 任何阶段升级失败，Vault 文件不受损；迁移前必备份 |

## 1. 通用机制（迁移时语义必须等价）

- **鉴权**：单工作区令牌（`X-Workspace-Token`/Bearer/`workspaceToken=`），AI 另有 `AI_ACCESS_TOKEN`（仅 Bearer）。桌面单机形态下由进程内信任替代，HTTP 令牌机制随 Express 退役；P4 MCP sidecar 使用一次性本地 RPC 令牌。
- **角色**：viewer/editor/admin，由请求 `role` 字段或配置决定；viewer 写保护由 `forbidViewerWrite` 执行。Rust 侧对应"写命令统一走 WorkspaceService 权限检查"。
- **确认闸门**：`requireFileConfirmation`——写操作需 `confirmed=true`，删除类 destructive 还需 `secondConfirmed=true`；files/AI-operations 另有 plan/planHash 计划校验与 `additionalConfirmed`/`sensitiveConfirmed` 三重确认。**IPC 命令保留同等语义参数**。
- **错误形状**：`{ error: { code, message, requestId } }`；成功 `{ data }` 或 `{ data, meta }`。Rust 命令错误模型按此对齐（code 枚举化）。
- **限流**：API 30 次/分、grep 60 次/分、附件上传 20 次/分——单机 IPC 无需限流，MCP sidecar 恢复。
- **流式端点**：SSE 全部改为 Tauri event/channel（§2 ai、§17 vault/events）。
- **乐观锁**：notes `expectedHash`、canvas `expectedHash`、review `planHash` 不匹配 → 409。

## 2. 端点清单（总计 96）

状态图例：⬜ 待迁移 ｜ 🔁 改为事件 ｜ ⛔ 随 Express 废弃 ｜ ✅ 已有对应 Rust 命令

> ⚠️ **✅ 只表示「已有对应 Rust 命令」，不代表前端路由已能走 IPC**——路由可用性由 §5.1–5.3 单独核销（例如 `note_create` 命令存在但缺 `folderId` 形参，路由仍在排除清单里）。
> 本节状态列曾长期滞后于实现（P1-04 迁移完成时未回填，`note_index`/`folder_tree`/`canvas_read` 等命令早已注册却仍标 ⬜），已于 2026-10-14 按 `src-tauri/src/lib.rs` 的 `generate_handler!` 实际注册清单校正 23 行：校正后仍为 ⬜ 的只有 **§5.3 那 10 条真正缺命令** + **P4 的 4 条**（`update_check`、`mcp_*` 3 条）+ **P3 的 ai 20 条**。

### 2.1 探针（app 根层，无鉴权）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/health` | — | `{data:{status,uptimeSeconds,env}}` | 纯探针 | ⛔ 桌面单机无探针需求 | ⛔ |
| GET | `/ready` | — | 200 `{data:{status,database}}` / 503 | db SELECT 1 | ⛔ 由启动恢复序列替代（架构 §11） | ⛔ |

### 2.2 vault（15）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/api/vault/info` | — | `{data:{vaultDir,mode,profile,profilePath,profileStatus,profileWarning}}` | vault/profile | `vault_info`（已实现，需补 profile 字段） | ✅/⬜ |
| PUT | `/api/vault/profile` | body: `paths{inbox,daily,journal}, confirmed, secondConfirmed` | 同上 | vault/profile | `vault_profile_set` | ⬜ |
| GET | `/api/vault/attachments` | — | `{data:[附件]}` | vault.attachments | `vault_attachments_list` | ✅ |
| GET | `/api/vault/files` | — | `{data:[文件]}` | vault.attachments | `vault_files_list` | ✅ |
| GET | `/api/vault/download` | query: `path` | **二进制下载** | vault.attachments | `vault_download`（批次6 新增，原记 vault_read_asset 有误） | ✅ |
| POST | `/api/vault/attachments` | **raw body**≤25MB；query: `name, folder?, confirmed…` | 201 | vault.attachments | `vault_attachment_upload`（参数改字节数组） | ✅ |
| GET | `/api/vault/attachments/references` | query: `path` | `{data:[引用]}` | vault.attachments | `vault_attachment_references` | ✅ |
| POST | `/api/vault/attachments/validate` | body: `content≤200万, filePath?` | 校验结果 | vault.attachments | `vault_attachment_validate` | ✅ |
| POST | `/api/vault/attachments/cleanup` | body: `dryRun, confirmed, secondConfirmed` | 清理结果 | vault.attachments | `vault_attachment_cleanup` | ✅ |
| DELETE | `/api/vault/attachments` | query: `path, confirmed, secondConfirmed` | 删除结果 | vault.attachments | `vault_attachment_delete` | ✅ |
| GET | `/api/vault/attachment` | query: `path` | **二进制**（SVG 强制 attachment 防 XSS） | vault.attachments | `vault_read_asset`（已实现） | ✅ |
| GET | `/api/vault/assets` | — | `{data:[资产]}` | vault.service | `vault_assets_list` | ⬜ |
| GET | `/api/vault/asset` | query: `path` | **二进制图片** | vault.service | `vault_read_asset`（已实现） | ✅ |
| POST | `/api/vault/migrate` | body: `confirmed, secondConfirmed` | 迁移结果（SQLite→Markdown） | migrate-sqlite | `vault_migrate_sqlite` | ⬜ |
| GET | `/api/vault/events` | sseTicket 或头令牌 | **SSE 文件变更流** | vault/events | 🔁 Tauri event：`vault://changed`（票据机制废弃） | 🔁 |

### 2.3 notes（13）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/api/notes` | query: `folderId?('__none__'), inboxStatus?, tagId?, sort, limit, offset` | `{data:[笔记], meta:{total,limit,offset}}` | notes.service | `note_list` | ⬜ |
| POST | `/api/notes` | body: `id?(幂等), title?, content≤200万, folderId?, properties, confirmed…` | 201 | notes.service | `note_create` | ✅ |
| GET | `/api/notes/index` | — | 索引 | notes.service | `note_index` | ✅ |
| GET | `/api/notes/templates` | — | 模板列表 | notes.templates | `note_templates_list` | ⬜ |
| POST | `/api/notes/from-template` | body: `template, title?, date?, folderId?, confirmed…` | 201 | notes.templates | `note_create_from_template` | ⬜ |
| POST | `/api/notes/daily` | body: `date?, confirmed…` | 201 | notes.templates | `note_create_daily` | ⬜ |
| GET | `/api/notes/:id` | path: `id`(UUID) | 详情 | notes.service | `note_get` | ⬜ |
| PATCH | `/api/notes/:id` | body: `title?, content?, folderId?, isPinned?, properties?, expectedHash?(409), confirmed…`；仅改 title/folderId 要求确认 | 笔记 | notes.service | `note_update` | ✅ |
| DELETE | `/api/notes/:id` | body: `confirmed, secondConfirmed` | 删除结果 | notes.service | `note_delete` | ✅ |
| POST | `/api/notes/:id/duplicate` | body: `folderId?, confirmed…` | 201 | notes.service | `note_duplicate` | ⬜ |
| GET | `/api/notes/:id/history` | — | 版本列表 | notes.service | `note_history_list` | ✅ |
| GET | `/api/notes/:id/history/:version` | — | 版本内容 | notes.service | `note_history_get` | ✅ |
| POST | `/api/notes/:id/history/:version/restore` | body: `expectedCurrentHash?, confirmed…` | 笔记 | notes.service | `note_history_restore` | ✅ |

### 2.4 canvas（5）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/api/canvas/files` | — | 文件列表 | canvas.service | `canvas_list` | ✅ |
| GET | `/api/canvas/` | query: `path` | 画布 JSON | canvas.service | `canvas_read` | ✅ |
| PUT | `/api/canvas/` | body: `nodes≤10000, edges≤20000, expectedHash?(409), confirmed…`；仅新建要求确认 | 写入结果 | canvas.service | `canvas_write` | ✅ |
| PATCH | `/api/canvas/file` | body: `fromPath, toPath, confirmed…` | 移动结果 | canvas.service | `canvas_move` | ✅ |
| DELETE | `/api/canvas/file` | query/body: `path, confirmed, secondConfirmed` | 删除结果 | canvas.service | `canvas_delete` | ✅ |

### 2.5 folders（4）/ tags（2）/ search（1）/ graph（1）/ meta（1）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/api/folders` | — | 目录树 | folders.service | `folder_tree` | ✅ |
| POST | `/api/folders` | body: `name, parentId?, sortOrder?, confirmed…` | 201 | folders.service | `folder_create` | ✅ |
| PATCH | `/api/folders/:id` | body: `name?, parentId?, sortOrder?, confirmed…` | 目录 | folders.service | `folder_update` | ✅ |
| DELETE | `/api/folders/:id` | body: `confirmed, secondConfirmed` | 删除结果 | folders.service | `folder_delete` | ✅ |
| GET | `/api/tags` | — | 标签列表 | tags.service | `tag_list` | ✅ |
| DELETE | `/api/tags/:id` | — | 删除结果 | tags.service | `tag_delete`（唯一免确认删除） | ⬜ |
| GET | `/api/search` | query: `q(必填), limit, folderId?, inboxStatus?` | `{data, meta:{query,strategy,count}}` | search.service | `search_query`（FTS5+trigram 语义不变） | ✅ |
| GET | `/api/graph` | — | 节点/边 | graph.service | `graph_build` | ✅ |
| GET | `/api/meta/overview` | — | 知识库概况 | meta.service | `meta_overview` | ✅ |

### 2.6 files（7）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/api/files/read` | query: `path, offset, limit≤2MB` | 文件内容 | files.service | `file_read` | ✅ |
| GET | `/api/files/find` | query: `pattern(glob), dir, type?` | 匹配文件 | files.service | `file_find` | ✅ |
| GET | `/api/files/grep` | query: `query, dir, regex, type?` | 命中结果 | files.service | `file_grep` | ✅ |
| POST | `/api/files/preview` | 单动作或 `actions[]≤30` | 预览+plan（viewer 置 `blocked` 不抛错） | files.service | `file_preview` | ✅ |
| POST | `/api/files/execute` | 同上 + `confirmed, secondConfirmed, planId, planHash` | 执行结果 | files.service | `file_execute` | ✅ |
| POST | `/api/files/undo` | body: `operationId?, force` | 撤销结果 | files.service | `file_undo` | ✅ |
| GET | `/api/files/log` | query: `limit≤500` | 操作日志 | files.service | `file_log` | ✅ |

### 2.7 experts（11）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/api/experts` | — | 专家列表 | experts.registry | `expert_list` | ✅ |
| GET | `/api/experts/:id` | — | 专家详情 | experts.registry | `expert_get` | ✅ |
| POST | `/api/experts` | body: expert + `confirmed…` | 201 | experts.registry | `expert_save` | ✅ |
| PUT | `/api/experts/:id` | 同上 | 专家 | experts.registry | `expert_save`（复用） | ✅ |
| DELETE | `/api/experts/:id` | body: `confirmed, secondConfirmed` | 删除结果 | experts.registry | `expert_delete` | ✅ |
| POST | `/api/experts/route` | body: `message, excludeId?` | 推荐专家 | experts.registry | `expert_route` | ✅ |
| GET | `/api/experts/skills` | — | 技能列表 | experts.registry | `skill_list` | ✅ |
| GET | `/api/experts/skills/:id` | — | 技能详情（含 content） | experts.registry | `skill_get` | ✅ |
| POST | `/api/experts/skills` | body: skill + `confirmed…` | 201 | experts.registry | `skill_save` | ✅ |
| PUT | `/api/experts/skills/:id` | 同上 | 技能 | experts.registry | `skill_save`（复用） | ✅ |
| DELETE | `/api/experts/skills/:id` | body: `confirmed, secondConfirmed` | 删除结果 | experts.registry | `skill_delete` | ✅ |

### 2.8 jobs（3）/ workspace（1）/ update（1）/ mcp（3）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/api/jobs` | query: `type?, status?, limit` | 任务列表 | lib/jobs | `job_list`（P1-03 持久化任务队列） | ✅ |
| GET | `/api/jobs/:id` | — | 任务 | lib/jobs | `job_get` | ✅ |
| POST | `/api/jobs/:id/cancel` | — | 取消后任务 | lib/jobs | `job_cancel` | ✅ |
| POST | `/api/workspace/sse-ticket` | — | `{ticket, expiresInMs:30000}` | workspace/sse-tickets | ⛔ IPC 无需票据 | ⛔ |
| GET | `/api/update/check` | query: `current?` | 更新检查 | update.service | `update_check`（P4 换 tauri-plugin-updater） | ⬜(P4) |
| GET | `/api/mcp/info` | — | 名称/传输/工具清单/写开关 | mcp.controller | `mcp_info`（P4 sidecar） | ⬜(P4) |
| GET | `/api/mcp/project` | — | `<Vault>/.lattice/mcp.json` 内容 | mcp.project | `mcp_project_get` | ⬜(P4) |
| PUT | `/api/mcp/project` | body: `mcpServers{}` + `confirmed…` | 保存结果 | mcp.project | `mcp_project_set` | ⬜(P4) |

### 2.9 ai（22，P3 迁移）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| POST | `/api/ai/chat` | body: `message, expertId, routingMode, context{…}, history, provider{…}, sessionId, mode, mcpServers[]…` | 对话结果 | ai.service | `ai_chat` | ⬜(P3) |
| POST | `/api/ai/chat/stream` | 同上 | **SSE**：meta→delta*→done | ai.service | 🔁 `ai_chat` + Tauri channel 流式 | 🔁(P3) |
| POST | `/api/ai/write` | body: `instruction, text, mode, title?, provider?` | 结果 | ai.service | `ai_write` | ⬜(P3) |
| POST | `/api/ai/write/stream` | 同上 | **SSE** | ai.service | 🔁 channel 流式 | 🔁(P3) |
| POST | `/api/ai/test` | body: `provider{…}, kind(chat/embedding)` | 测试结果 | ai.service | `ai_provider_test` | ⬜(P3) |
| GET | `/api/ai/settings` | — | 掩码后配置 | ai.settings | `ai_settings_get` | ⬜(P3) |
| PUT | `/api/ai/settings` | body: `providers[], activeProviderId, embedding{}` | 掩码后配置（副作用 reindexAll） | ai.settings | `ai_settings_set` | ⬜(P3) |
| GET | `/api/ai/sessions` | query: `expertId?, query?, limit, offset` | 会话分页（no-store） | ai.sessions | `ai_session_list` | ⬜(P3) |
| POST | `/api/ai/sessions` | body: `title?, id?, expertId?` | 会话 | ai.sessions | `ai_session_create` | ⬜(P3) |
| GET | `/api/ai/sessions/:id/messages` | — | 会话+消息 | ai.sessions | `ai_session_messages` | ⬜(P3) |
| PATCH | `/api/ai/sessions/:id` | body: `title` | 会话 | ai.sessions | `ai_session_rename` | ⬜(P3) |
| DELETE | `/api/ai/sessions/:id` | — | 删除结果 | ai.sessions | `ai_session_delete` | ⬜(P3) |
| GET | `/api/ai/index/status` | — | 索引状态+reindexJob | ai.embeddings | `ai_index_status` | ⬜(P3) |
| POST | `/api/ai/index/reindex` | — | 202 jobId | ai.indexer | `ai_index_reindex` | ⬜(P3) |
| GET | `/api/ai/related` | query: `noteId, limit≤12` | 相关笔记 | ai.retrieval | `ai_related` | ⬜(P3) |
| POST | `/api/ai/retrieval/preview` | body: `query` | 双路命中与融合 | ai.retrieval | `ai_retrieval_preview` | ⬜(P3) |
| GET | `/api/ai/suggestions` | query: `noteId, limit≤10` | 双链/标签建议 | ai.suggestions | `ai_suggestions` | ⬜(P3) |
| POST | `/api/ai/digest` | — | 摘要结果 | ai.digest | `ai_digest` | ⬜(P3) |
| POST | `/api/ai/mcp/warmup` | body: `mcpServers[], role` | 202 started | ai.mcp | `ai_mcp_warmup` | ⬜(P3/P4) |
| POST | `/api/ai/operations/preview` | body: `actions[]≤30, actor, role` | 计划 | ai.operations | `ai_operations_preview` | ⬜(P3) |
| POST | `/api/ai/operations/execute` | body: `actions[], confirmed, additionalConfirmed, sensitiveConfirmed, planId?, planHash?` | 执行结果 | ai.operations | `ai_operations_execute` | ⬜(P3) |
| GET | `/api/ai/history` | query: `limit≤250` | 审计日志 | ai.operations | `ai_history` | ⬜(P3) |

### 2.10 review（3）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/api/review/health` | query: `staleDays≥7, limit` | 健康扫描 | knowledge-health | `review_health`（实现命令名） | ✅ |
| POST | `/api/review/health/plan` | body: `findingIds≤100, staleDays?, limit?` | 修复计划（planId/planHash） | knowledge-health | `review_plan`（实现命令名） | ✅ |
| POST | `/api/review/health/execute` | body: `planId, planHash, confirmed, secondConfirmed` | 执行结果 | knowledge-health | `review_execute`（实现命令名） | ✅ |

## 3. scripts/ Node 工作区盘点（P4 sidecar 评估输入）

| 工作区 | 入口 | 启动 | 测试 | P4 处置 |
|---|---|---|---|---|
| `scripts/mcp-server` | server.mjs（stdio） | `npm start` | `node e2e.mjs` | 由 `lattice-mcp` sidecar（P4-00）替换：工具面=本清单 vault/notes/search 只读+受控写；禁止直接打开 DB |
| `scripts/notion-calendar-mcp` | server.mjs（stdio） | `npm start` | `node --test calendar.test.mjs` + `e2e.mjs` | 保留为可选外部工具，从根 setup/verify/test:mcp 脚本链路摘除（计划 P1-09） |

## 4. 迁移要点（代码勘察结论）

1. 4 条 SSE 流改 Tauri event/channel；`sse-ticket` 票据机制整体废弃。
2. 两套确认体系并存：通用 `confirmed/secondConfirmed` 与 plan/planHash+三重确认（files、ai-operations）。IPC 命令保留同等语义。
3. 乐观锁三处：notes/canvas `expectedHash`→409，review `planHash` 校验。
4. 附件上传为 raw 字节流（≤25MB），IPC 改字节数组参数。
5. 特例必须逐条保留：PATCH notes 仅 title/folderId 需确认；PUT canvas 仅新建需确认；DELETE tags 免确认；files/preview 对 viewer 返回 blocked 不抛错。

## 5. 双轨映射核销（P1-05 收尾，2026-10-14）

> 问题：P1-04 交付了 59 个 Rust 命令，但**命令存在 ≠ 前端路由能用**。为写「HTTP 路由 → 命令」映射表，对前端 81 个 `http.*` 调用点归并出的 58 条非 AI/MCP 路由逐条比对入参与返回结构。
> **结果：审计时为 34 条可对齐进表（31 直接 + 3 需适配），24 条排除（11 缺命令 / 13 结构不兼容）。**
> **后续回收（Δ13 处置）：已回收 2 条** —— `GET /notes/index`（`2d34ae9`，Rust 补 `properties` 对象）与 `GET /canvas/files`（`7d4cac9`，`canvas_list` 改回 `{path,name,folderPath}` 对象数组），**现为 36 条进表 / 22 条排除（11 结构不兼容）**。
> 权威清单与行号证据：`web/src/api/ipc-routes.ts` 末尾「排除清单」；执行侧登记见 execution-log.md Δ13。

### 5.1 已可对齐（34）

- 直读类：`/vault/attachments`→`vault_attachments_list`、`/vault/files`→`vault_files_list`、`/tags`→`tag_list`、`/graph`→`graph_build`、`/meta/overview`→`meta_overview`、`/folders`→`folder_tree`、`/canvas`→`canvas_read`、`/files/log`→`file_log`、`/experts`→`expert_list`、`/experts/skills`→`skill_list`
- 带参与动态段：`/vault/attachments/references`、`/vault/attachments/validate`、`/vault/attachments/cleanup`、`DELETE /vault/attachments`、`/review/health`、`/experts/:id`、`/experts/skills/:id`、`POST /experts`、`PUT /experts/:id`、`DELETE /experts/:id`、`POST/PUT/DELETE /experts/skills*`、`/files/undo`、`DELETE /notes/:id`、`POST /notes/:id/history/:version/restore`、`PATCH /canvas/file`、`DELETE /canvas/file`、`/review/health/plan`、`/review/health/execute`
- 需适配（3）：`PUT /canvas` 的文档体拆 `nodes`/`edges`；`POST /files/preview` 与 `/files/execute` 的 `action`/`actions` 二态

### 5.2 结构不兼容（13，比缺命令更危险——接上去会静默改行为）

| 路由 | 不兼容点 |
|---|---|
| `GET /vault/info` | 命令只回 `{path}`，前端消费 `vaultDir` + `profile` |
| `POST /vault/attachments` | 命令无 `folder` 形参；返回裸 String 而前端读 `uploaded.path/name` |
| `GET /vault/download` | 前端直接 `fetch`+`blob()`；命令返回 base64 JSON |
| `GET /notes/index` | ~~命令发 `propertiesJson`(string)，前端当对象消费~~ **已修（`2d34ae9`）：Rust 同时发 `properties` 对象，该路由已回收进表** |
| `POST /notes` | `note_create` 无 `folder_id` 形参 |
| `PATCH /notes/:id` | `note_update` 无 `folder_id` 形参（移动笔记无法表达） |
| `GET /notes/:id/history` | 前端期望 `{items,currentHash}`，命令回数组 |
| `GET /notes/:id/history/:version` | 前端期望 `{version,createdAt,title,content,isPinned,properties}`，命令只给 `{version,raw,hash}` |
| `POST /folders` | 命令收父目录**路径** `parent_path`，前端传 `parentId` |
| `PATCH /folders/:id` | 命令收 `new_parent_path`，前端传 `parentId`；且命令回全树而前端类型是单节点 |
| `DELETE /folders/:id` | 前端读 `affectedNoteCount`（命令无）；Rust 对非空目录 CONFLICT 拒绝 vs Express「笔记移到未分类」 |
| `GET /search` | `search_query` 仅 `(q,limit)`，无法表达 `folderId`/`inboxStatus`；返回信封不同 |
| `GET /canvas/files` | ~~`canvas_list` 回 `Vec<String>`，前端消费 `path/name/folderPath` 对象~~ **已修（`7d4cac9`）：改回对象数组，该路由已回收进表** |

### 5.3 缺命令（11）

`vault_profile_set`、`vault_migrate_sqlite`、`vault_assets_list`、`note_list`、`note_get`、`note_duplicate`、`note_templates_list`、`note_create_from_template`、`note_create_daily`、`tag_delete`（均为契约 ⬜），以及 ⛔ 的 `/health`。

### 5.4 对 P1-08 / P1-09 的约束

1. **在 5.2/5.3 补齐前，不得把桌面入口切到全功能 App**（计划 §5.3-5 的顺序约束由此获得实证依据）。
2. 横向共性问题：note 系命令统一以 `propertiesJson: Option<String>` 过线缆，而前端 `NoteDetail`/`NoteIndexEntry` 的 `properties` 是对象——建议在 Rust 侧直接发对象或在 IPC 层统一反序列化，否则每个 note 系命令都要各自适配。
3. folder 系命令以**路径**寻址，前端以 **id** 寻址——需在 P1-08 决定统一口径（新增 id→path 解析命令，或前端改传路径）。
4. 错误形状仍不一致：命令是 `Result<T, String>`（裸字符串，无 code），契约 §1 的目标是 `{error:{code,message,requestId}}`。双轨阶段已在 `client.ts` 归一为 `ApiError(code='IPC_ERROR')`，但 `ServiceError.code` 的枚举值目前**未过线缆**，`ApiError.code` 在桌面态无法细分——建议 P1-08 一并改为 `Result<T, ServiceError>`。

### 5.5 契约快照基准（P1-08 第 1 步，`src-tauri/tests/fixtures/`）

来自 Express 的**真实**请求/响应快照，是 §5.2 各条差异的实测证据来源，也是 Rust 侧断言的唯一基准。

- 生成：`npm run record:fixtures`（`src-tauri/tests/tools/record-fixtures.mjs`）——临时 Express + 确定性 seed vault，驱动 59 个命令中的 50 个；**幂等**（连续两次运行目录哈希一致）
- 自检：`npm run verify:fixtures`（`validate-fixtures.mjs`，已接入根 `verify` 链）——schema 必须等于由 data 重算的 schema、无残留未归一值、索引与 case 数一致
- 结构：`cases/<command>.json`（请求 + `data` + 递归 `schema` + `volatilePaths`）、`seed/manifest.json` + `seed/vault/**`（重建同一 Vault）、`index.json`（覆盖：50 录得 / 9 跳过 / 20 条端点无命令）
- 未覆盖的 9 个命令：7 个 Rust 内部 `vault_*`（Express 无对应端点）、`job_get`/`job_cancel`（job 仅由 P3 端点创建，无法确定性播种）
- **实测新增待对齐项**：Express 对**行首 `#标签`** 有 heading 启发式（该标签会被当作标题吃掉），播种标签须内联；Rust 侧标签解析若不一致，`tag_list`/`note_*` 的 fixture 会对不上，需在 P1-08 对齐
- 注意：命令经 F2 修复后是 crate 私有 `fn`，故第 2 步的 Rust 断言须落在 `src/` 内的 `#[cfg(test)]`；`src-tauri/tests/` 目录调不到命令

### 5.6 双通道对齐断言与差异基线（P1-08 第 2 步，`6555003`）

- **静态参数契约**：`web/test/ipc-args-contract.test.mjs` —— 逐命令断言「映射表 args 构造器产出的键 ⊆ Rust 形参」且「Rust 必填形参都被提供」（多传键会被 invoke 拒绝、少传必填参数会运行时报错）。覆盖 36 条路由 / 34 个命令，0 跳过。
- **运行时结构对齐**：`src-tauri/src/parity_tests.rs` —— 重建 `seed/vault` 后按 fixture 时序回放，逐字段 diff。
- **差异基线**：`src-tauri/tests/fixtures/divergence.json`，当前 **19 个命令 / 66 条**（首版 27 / 99，随 Δ13 增量收缩：`2d34ae9` 99→96，`af0fa83` 96→93，`80977f5` 93→81 且 `note_update`/`note_history_restore` **完全对齐**，`6de9dc0` 81→80 且 `note_create` 完全对齐，`7d4cac9` 80→76 且 `canvas_list` 完全对齐，`d1d94b7` 76→66 且 **canvas 五条命令全部对齐**）。清单可收缩：Rust 侧补齐一处 → 实际差异少一条 → 测试失败并点名要删的条目。
- **优先级：按「是否已在映射表内」分类**。表内命令的差异在桌面态是**活的**——该路由走 invoke，UI 拿到的就是 Rust 的响应，而 web 版走 Express，两个通道行为不同；仍在排除清单里的路由回落 HTTP，行为与迁移前一致。首版 76 条里 **30 条属前者**，应先修。注意 `canvas_write`/`canvas_move`/`canvas_delete` 当年被审计判为 MAP（而非不兼容），原因只是**调用方忽略了返回值**——一旦有人开始消费就会静默出错，故不能因为「当前没人用」而搁置。
- 收缩时可能**同时暴露更深一层**的差异：补齐 `properties` 对象后，`note_update` 立刻多出 `properties.status`/`properties.type` 两条——因为原先 `properties` 整个缺失，diff 看不见对象内部。这类「净减少但更精确」的变化是预期行为，不要当成回归。
- **schema diff 结构性看不见的三类差异**（只能靠读 Express 源码发现，`d1d94b7` 一次抓到三处）：
  1. **Rust 提前报错**：`canvas_delete` 原对「文件已不存在」抛 NOT_FOUND，Express 则返回 `{path, deleted:true}`（幂等：过期树条目/被外部删除的文件要能被清掉）。表现为「一方成功一方报错」时，若 diff 只看成功响应，就完全看不到。
  2. **形状相同但行为不同**：`canvas_move` 缺 Express 的 sameFile 豁免（Windows 大小写不敏感，`画板.canvas → 画板.Canvas` 会被 `exists()` 误判为目标已存在）。
  3. **写盘副作用**：`canvas_write` 序列化时漏了 Express 的 `version: 1` 与结尾换行，两通道写同一 Vault 的文件格式不一致。**已知限制**：不经 `serde_json` 的 `preserve_order`（会改变全 crate 的 JSON 输出顺序）无法做到与 Express 字节相同，本项只对齐字段内容、不对齐键序。
- 顺带补齐的**安全防护缺口**：canvas 三命令原缺符号链接防护，而 Express 对 write/move/remove 都跑 `assertWritablePath`（父链符号链接遍历）。Rust 早有同一套实现 `fc_assert_no_symlink`，且其他写入路径都在用，只有 canvas 漏了——已补（属**收紧**，不是为 parity 放宽边界）。
- **两个操作/能力上的坑（踩过）**：
  1. `record-fixtures.mjs` 会 `rm -rf` 整个 fixtures 目录（`record-fixtures.mjs:686`），**因此重录会连 `divergence.json` 一起删掉**，下一次 parity 会「自动重建基线 + 报一次首次运行的失败」。这看起来像 harness 飘了，实际是设计使然——别误判成 flaky。
  2. **数组只比对首元素**：schema diff 对数组仅采样 `element[0]`。所以「后面元素某字段类型不对」这类问题看不出来（例如 `note_index` 的后续元素若 `propertiesJson` 为 null，基线不会报）。`note_create` 那条归一是因为它的响应是单个对象才被抓住；扩展 harness 时应优先补这项。
- 行尾：新增 `.gitattributes` 把 `src-tauri/tests/fixtures/**` 钉为 LF（`20c6739`）。本机 `core.autocrlf=true`，否则全新克隆会把 fixtures 改写成 CRLF，破坏「两次录制逐字节一致」这一前提。
- 差异种类：`missing-in-rust`（Express 有、Rust 无）/ `extra-in-rust` / `type-mismatch` / `error`（Rust 直接报错）。
- 当前**唯一** `error` 类：`vault_read_asset`（`read_asset` 白名单窄于 Express，见 Δ14，待产品定夺；**不可**为消除它而擅自放宽安全边界）。
- 已知的若干条差异已是 5.2 各条结论的实测映射，例如：`note_index` 缺 `properties`(object)、`vault_info` 多 `path` 且缺 `vaultDir`/`profile`/`mode`、`folder_update` 返回 `array`（全树）vs `object`（单节点）、`note_history_list` 返回 `array` vs `{items,currentHash}`。

### 5.7 消费层一致性（P1-08 第 3 步，`5585a04`）

`web/test/ipc-parity-consumption.test.mjs`（已进 web `test` 链）——数据驱动，把 50 个 fixture 的同一份 `data` 分别经 ①HTTP（fetch 桩返回 `{data}` 信封）与 ②IPC（invoke 桩直接返回数据本身）走一遍 `api` 层，断言**两条通道交付给消费层的值逐字节相同**（50/50），即双轨封装（信封还原 / 错误归一 / 参数传递）在消费缝上没有引入偏差。

同时钉住「实际走了哪条通道」，这也是对 §5.1/§5.2 划分的运行时复核：

| 情形 | 期望 | 实测 |
|---|---|---|
| 路由在 `IPC_ROUTES` 内 | 走 invoke，且**不得**回落 HTTP | 32/32 ✅ |
| 路由被排除（§5.2/§5.3） | 必须回落 HTTP | 18/18 ✅ |
| 路由匹配上但 `args` 自述表达不了 | **不得静默回落**（真实桌面端无 Express 兜底） | 0 例 ✅ |

错误路径：HTTP 400 `{error:{message}}` 与 IPC 抛出同一文案时，两通道的**用户可见 message 一致**；`code` 不同（HTTP 保留服务端 code，IPC 为裸字符串只能标 `IPC_ERROR`）——即 §5.4-4 待改进项，此处以断言形式记录在案。

该测试做过三种破坏的反向验证（删表内路由 / IPC 侧不套信封 / 强制 `args` 返回 undefined），全部被拦并点名具体命令——「能过」不等于「有效」。
