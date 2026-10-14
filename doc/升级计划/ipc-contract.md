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
| POST | `/api/notes` | body: `id?(幂等), title?, content≤200万, folderId?, properties, confirmed…` | 201 | notes.service | `note_create` | ⬜ |
| GET | `/api/notes/index` | — | 索引 | notes.service | `note_index` | ⬜ |
| GET | `/api/notes/templates` | — | 模板列表 | notes.templates | `note_templates_list` | ⬜ |
| POST | `/api/notes/from-template` | body: `template, title?, date?, folderId?, confirmed…` | 201 | notes.templates | `note_create_from_template` | ⬜ |
| POST | `/api/notes/daily` | body: `date?, confirmed…` | 201 | notes.templates | `note_create_daily` | ⬜ |
| GET | `/api/notes/:id` | path: `id`(UUID) | 详情 | notes.service | `note_get` | ⬜ |
| PATCH | `/api/notes/:id` | body: `title?, content?, folderId?, isPinned?, properties?, expectedHash?(409), confirmed…`；仅改 title/folderId 要求确认 | 笔记 | notes.service | `note_update` | ⬜ |
| DELETE | `/api/notes/:id` | body: `confirmed, secondConfirmed` | 删除结果 | notes.service | `note_delete` | ⬜ |
| POST | `/api/notes/:id/duplicate` | body: `folderId?, confirmed…` | 201 | notes.service | `note_duplicate` | ⬜ |
| GET | `/api/notes/:id/history` | — | 版本列表 | notes.service | `note_history_list` | ⬜ |
| GET | `/api/notes/:id/history/:version` | — | 版本内容 | notes.service | `note_history_get` | ⬜ |
| POST | `/api/notes/:id/history/:version/restore` | body: `expectedCurrentHash?, confirmed…` | 笔记 | notes.service | `note_history_restore` | ⬜ |

### 2.4 canvas（5）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/api/canvas/files` | — | 文件列表 | canvas.service | `canvas_list` | ⬜ |
| GET | `/api/canvas/` | query: `path` | 画布 JSON | canvas.service | `canvas_read` | ⬜ |
| PUT | `/api/canvas/` | body: `nodes≤10000, edges≤20000, expectedHash?(409), confirmed…`；仅新建要求确认 | 写入结果 | canvas.service | `canvas_write` | ⬜ |
| PATCH | `/api/canvas/file` | body: `fromPath, toPath, confirmed…` | 移动结果 | canvas.service | `canvas_move` | ⬜ |
| DELETE | `/api/canvas/file` | query/body: `path, confirmed, secondConfirmed` | 删除结果 | canvas.service | `canvas_delete` | ⬜ |

### 2.5 folders（4）/ tags（2）/ search（1）/ graph（1）/ meta（1）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/api/folders` | — | 目录树 | folders.service | `folder_tree` | ⬜ |
| POST | `/api/folders` | body: `name, parentId?, sortOrder?, confirmed…` | 201 | folders.service | `folder_create` | ⬜ |
| PATCH | `/api/folders/:id` | body: `name?, parentId?, sortOrder?, confirmed…` | 目录 | folders.service | `folder_update` | ⬜ |
| DELETE | `/api/folders/:id` | body: `confirmed, secondConfirmed` | 删除结果 | folders.service | `folder_delete` | ⬜ |
| GET | `/api/tags` | — | 标签列表 | tags.service | `tag_list` | ⬜ |
| DELETE | `/api/tags/:id` | — | 删除结果 | tags.service | `tag_delete`（唯一免确认删除） | ⬜ |
| GET | `/api/search` | query: `q(必填), limit, folderId?, inboxStatus?` | `{data, meta:{query,strategy,count}}` | search.service | `search_query`（FTS5+trigram 语义不变） | ⬜ |
| GET | `/api/graph` | — | 节点/边 | graph.service | `graph_build` | ⬜ |
| GET | `/api/meta/overview` | — | 知识库概况 | meta.service | `meta_overview` | ⬜ |

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
| GET | `/api/experts` | — | 专家列表 | experts.registry | `expert_list` | ⬜ |
| GET | `/api/experts/:id` | — | 专家详情 | experts.registry | `expert_get` | ⬜ |
| POST | `/api/experts` | body: expert + `confirmed…` | 201 | experts.registry | `expert_save` | ⬜ |
| PUT | `/api/experts/:id` | 同上 | 专家 | experts.registry | `expert_save`（复用） | ⬜ |
| DELETE | `/api/experts/:id` | body: `confirmed, secondConfirmed` | 删除结果 | experts.registry | `expert_delete` | ⬜ |
| POST | `/api/experts/route` | body: `message, excludeId?` | 推荐专家 | experts.registry | `expert_route` | ⬜ |
| GET | `/api/experts/skills` | — | 技能列表 | experts.registry | `skill_list` | ⬜ |
| GET | `/api/experts/skills/:id` | — | 技能详情（含 content） | experts.registry | `skill_get` | ⬜ |
| POST | `/api/experts/skills` | body: skill + `confirmed…` | 201 | experts.registry | `skill_save` | ⬜ |
| PUT | `/api/experts/skills/:id` | 同上 | 技能 | experts.registry | `skill_save`（复用） | ⬜ |
| DELETE | `/api/experts/skills/:id` | body: `confirmed, secondConfirmed` | 删除结果 | experts.registry | `skill_delete` | ⬜ |

### 2.8 jobs（3）/ workspace（1）/ update（1）/ mcp（3）

| 方法 | 路径 | 请求 | 响应 | 服务层 | 未来 Rust 命令 | 状态 |
|---|---|---|---|---|---|---|
| GET | `/api/jobs` | query: `type?, status?, limit` | 任务列表 | lib/jobs | `job_list`（P1-03 持久化任务队列） | ⬜ |
| GET | `/api/jobs/:id` | — | 任务 | lib/jobs | `job_get` | ⬜ |
| POST | `/api/jobs/:id/cancel` | — | 取消后任务 | lib/jobs | `job_cancel` | ⬜ |
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
| GET | `/api/review/health` | query: `staleDays≥7, limit` | 健康扫描 | knowledge-health | `review_health_scan` | ⬜ |
| POST | `/api/review/health/plan` | body: `findingIds≤100, staleDays?, limit?` | 修复计划（planId/planHash） | knowledge-health | `review_health_plan` | ⬜ |
| POST | `/api/review/health/execute` | body: `planId, planHash, confirmed, secondConfirmed` | 执行结果 | knowledge-health | `review_health_execute` | ⬜ |

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
