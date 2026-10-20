# Lattice AI 升级版本记录

> AI 升级统一使用本文件记录。每完成一项任务，将状态从 `[ ]` 更新为 `[x]`，并填写完成日期和验证证据。

## 状态说明

| 状态 | 含义 |
| --- | --- |
| `[x]` | 已实现并通过验证 |
| `[ ]` | 尚未完成 |

## 版本总览

| 版本 | 状态 | 开始日期 | 版本目标 |
| --- | --- | --- | --- |
| v0.3.0-alpha.1 | 进行中 | 2026-10-16 | 建立多意图路由、范围与权限边界、Agent 循环、写操作风险控制和可验证的执行基础 |

## v0.3.0-alpha.1 已完成项

| 状态 | 完成日期 | 任务 | 代码或验证证据 |
| --- | --- | --- | --- |
| [x] | 2026-10-16 | 建立 AI 升级版本记录文件 | `doc/版本记录/AI/AI升级版本记录.md` |
| [x] | 2026-10-16 | 支持写作、问答、搜索、Agent 任务的多意图识别 | `web/src/lib/ai-policy.ts` |
| [x] | 2026-10-16 | 增加路由置信度和模型档位：快速、标准、推理 | `web/src/lib/ai-policy.ts` |
| [x] | 2026-10-16 | 增加显式范围优先级解析 | `web/src/lib/ai-policy.ts` |
| [x] | 2026-10-16 | 增加检索源权限过滤接口 | `web/src/lib/ai-policy.ts` |
| [x] | 2026-10-16 | 增加 L0–L3 写操作风险分级 | `web/src/lib/ai-policy.ts` |
| [x] | 2026-10-16 | L1 可撤销写入默认自动放行 | `web/src/lib/ai-agent.ts` |
| [x] | 2026-10-16 | L2/L3 写入保留授权拦截 | `web/src/lib/ai-agent.ts` |
| [x] | 2026-10-16 | 增加 Agent 多轮决策循环 | `web/src/lib/ai-agent.ts` |
| [x] | 2026-10-16 | 只读工具并行、写工具串行 | `web/src/lib/ai-agent.ts` |
| [x] | 2026-10-16 | 增加步数、工具调用次数、token 和时间预算 | `web/src/lib/ai-agent.ts` |
| [x] | 2026-10-16 | 增加取消、失败和预算超限状态 | `web/src/lib/ai-agent.ts` |
| [x] | 2026-10-16 | 对话请求携带 `routing` 和 `budget` 元数据 | `web/src/components/AIAssistantPanel.tsx` |
| [x] | 2026-10-16 | 操作预览显示风险等级和风险原因 | `web/src/components/AIAssistantPanel.tsx` |
| [x] | 2026-10-16 | AI 策略和 Agent 运行时单元测试通过 | `web/test/ai-policy.test.mjs`、`web/test/ai-agent.test.mjs` |
| [x] | 2026-10-16 | Web 全量测试通过 | `npm --prefix web run test` |
| [x] | 2026-10-16 | TypeScript 类型检查通过 | `npm --prefix web run typecheck` |
| [x] | 2026-10-16 | Vite 生产构建通过 | `npm --prefix web run build` |

## v0.3.0-alpha.1 重构进度

| 状态 | 阶段 | 已完成内容 | 验证证据 |
| --- | --- | --- | --- |
| [x] | Phase 0：领域契约和运行状态 | 已建立 `AiRequest`、`AiContextBlock`、`AiRunEvent`、`AiRunResult`、Run 状态机、合法状态转移和事件序号 | `web/src/ai/contracts.ts`、`web/src/ai/run-state.ts`、`web/test/ai-contracts.test.mjs`、`web/test/ai-run-state.test.mjs` |
| [x] | Phase 1：AI 面板拆分 | Controller、Session Store、流式适配器、操作适配器和独立视图组件已接入面板 | Web 全量测试、类型检查、生产构建通过；`web/src/components/ai/` |
| [ ] | Phase 2：Provider 和 Context Pipeline | 已建立 Provider-neutral、HTTP/Tauri transport 边界和分层 ContextBuilder；真实 Tauri 命令接入、提示缓存待完成 | `web/src/ai/providers/`、`web/src/ai/context-builder.ts`、`web/test/ai-provider.test.mjs`、`web/test/ai-context.test.mjs` |
| [ ] | Phase 3：混合检索管线 | 已完成权限前置、FTS5/LIKE、本地向量 fallback、RRF、Rerank 和块级引用；MCP/联网召回仍待接入 | Rust 检索闭环已通过；外部召回和模型级 Rerank 尚未完成 |
| [ ] | Phase 4：Agent Tool Gateway | 已完成 Gateway 基础、AI Run 持久化运行骨架、阶段检查点、桌面 durable 事件回放和恢复提示；真实 WorkspaceService 写工具全量收口、跨进程工具状态重放仍待完成 | `web/src/ai/agent-tool-gateway.ts`、`web/src/ai/providers/tauri-provider.ts`、`web/src/ai/run-recovery.ts`、`src-tauri/src/jobs.rs`、`src-tauri/src/lib.rs` |
| [ ] | Phase 5：记忆、观测和评测 | P3-A/P3-B 与 P3-C 工程闭环已完成；真实远程模型运行样本和发布前最终验收仍待完成 | `src-tauri/src/memory.rs`、`web/src/api/memory.ts`、`web/src/ai/small-model.ts`、`web/src/ai/run-trace-store.ts`、`src-tauri/eval/quality-gate.mjs` |

### Phase 1 已完成子项

| 状态 | 完成日期 | 子项 | 代码或验证证据 |
| --- | --- | --- | --- |
| [x] | 2026-10-16 | AI 请求编排从面板抽出 | `web/src/ai/ai-controller.ts`、`web/test/ai-controller.test.mjs` |
| [x] | 2026-10-16 | HTTP/Provider 流式事件统一适配 | `web/src/ai/ai-stream-adapter.ts`、`web/test/ai-stream-adapter.test.mjs` |
| [x] | 2026-10-16 | 会话 CRUD 状态从 React 生命周期抽出并接入面板 | `web/src/ai/ai-session-store.ts`、`web/src/components/AIAssistantPanel.tsx`、`web/test/ai-session-store.test.mjs` |
| [x] | 2026-10-16 | HTTP/IPC 操作响应信封统一适配 | `web/src/ai/ai-operation-adapter.ts`、`web/test/ai-operation-adapter.test.mjs` |
| [x] | 2026-10-16 | AI 面板拆成独立视图组件 | `web/src/components/ai/AiProgressChecklist.tsx`、`AiMessageList.tsx`、`AiOperationPreview.tsx`、`AiExecutionSummary.tsx`、`AiSessionHistory.tsx` |
| [x] | 2026-10-16 | 删除 AI 面板中已迁移的重复内联组件和旧操作预览构建器，统一复用独立视图与 `aiOperationPlanner` 类型 | `web/src/components/AIAssistantPanel.tsx`、`web/src/ai/ai-operation-planner.ts`；类型检查、Web 全量测试和生产构建通过 |

### Phase 2 已完成子项

| 状态 | 完成日期 | 子项 | 代码或验证证据 |
| --- | --- | --- | --- |
| [x] | 2026-10-16 | 建立 Provider-neutral 请求与流式接口 | `web/src/ai/providers/provider.ts`、`web/test/ai-provider.test.mjs` |
| [x] | 2026-10-16 | 建立 HTTP Provider 适配器 | `web/src/ai/providers/http-provider.ts` |
| [x] | 2026-10-16 | 建立可注入的 Tauri Provider/事件传输边界 | `web/src/ai/providers/tauri-provider.ts`、`web/test/ai-provider.test.mjs` |
| [x] | 2026-10-16 | 建立系统、工具、记忆、检索、历史和附件的分层上下文组装 | `web/src/ai/context-builder.ts`、`web/test/ai-context.test.mjs` |
| [x] | 2026-10-16 | 将批量文件与 AI 归档动作统一收敛到操作规划器，保留失败项、风险、planId/planHash 和高风险确认原因 | `web/src/ai/ai-operation-planner.ts`、`web/test/ai-operation-planner.test.mjs` |
| [x] | 2026-10-16 | Controller 接入标准化 ContextBuilder blocks，同时保留原始 context 兼容现有请求 | `web/src/ai/ai-controller.ts`、`web/test/ai-controller.test.mjs` |
| [x] | 2026-10-16 | 接入真实 Tauri AI 流式命令和事件通道：按 `runId` 隔离事件，支持取消、delta、reasoning、done、error，并使用 OpenAI-compatible HTTP Provider | `src-tauri/src/ai_runtime.rs`、`src-tauri/src/lib.rs`、`web/src/components/AIAssistantPanel.tsx`；`cargo check --lib`、`cargo test --lib` 78/78、Provider 回归测试通过；尚未完成真实外部模型人工验收 |
| [x] | 2026-10-16 | 固定前缀提示缓存和超长上下文压缩 | `web/src/ai/context-builder.ts` 已接入固定前缀本地缓存和超长历史压缩；缓存键包含权限上下文 |

## P0 · 安全与执行边界

### P0-A · 路由与范围

| 状态 | 任务 | 说明 |
| --- | --- | --- |
| [x] | 多意图识别 | 支持一个请求同时命中多个意图 |
| [x] | 置信度计算 | 低置信度可被上层识别 |
| [x] | 模型档位选择 | 快速、标准、推理 |
| [x] | 低置信度真实澄清交互 | `web/src/lib/ai-policy.ts` 标记含糊短请求和低置信度路由；`AIAssistantPanel` 暂停发送并提供回答、检索、写作、文件操作四种方向，选择后将原请求与补充意图一起提交；策略测试、Web 全量测试、类型检查和生产构建通过 |
| [x] | 显式范围优先级解析 | 显式范围 > 选区 > 当前页面 > 知识库 > 外部 |
| [ ] | 输入框展示 `@页面` / `@连接器` 标签 | 当前只有请求层范围字段 |
| [ ] | 连接器来源接入统一权限服务 | 需要连接器级授权模型 |

### P0-B · 权限与不可信内容

| 状态 | 任务 | 说明 |
| --- | --- | --- |
| [x] | 建立检索前权限过滤函数 | 模型上下文组装前过滤未授权来源 |
| [x] | FTS5 查询实际接入权限过滤 | `src-tauri/src/index.rs` 的 `search_query_with_allowed_paths` 在 FTS/LIKE SQL 召回条件中使用参数化路径集合 |
| [x] | 建立 MCP/联网外部结果的不可信上下文协议 | `web/src/ai/contracts.ts` 增加 `external` 来源并强制视为不可信；`web/src/ai/context-builder.ts` 保留 provider/origin 元数据并序列化为 `<untrusted_external>`；上下文和契约测试通过 |
| [x] | 向量查询实际接入权限过滤 | `src-tauri/src/index.rs` 在加载向量候选前使用参数化 `allowed_paths`/`folder_id` SQL 过滤；随后仅对授权候选做余弦排序 |
| [ ] | MCP / 联网结果统一标记为不可信数据 | 需要统一上下文协议 |
| [x] | 工具执行前再次权限校验 | `web/src/ai/agent-tool-gateway.ts` 在 preflight 和 execute 两层校验 viewer 角色、路径字段、`permissionScope.allowedPaths`、scopeId/version 上下文传递和可选 authorize 回调；路径越界或缺少范围默认拒绝 |
| [x] | 缓存键包含权限上下文 | `web/src/ai/retrieval-cache.ts` 和 `context-builder.ts` 的缓存键绑定 actor、role、scopeId、permissionVersion、contentVersion，并将允许路径排序后纳入检索键 |
| [x] | 外部内容禁止直接触发高风险写工具 | Gateway 接收 `untrustedContext`，对 L2/L3 写入默认拒绝；只有 Agent 循环完成用户 `authorizeWrites` 后传入 `externalWriteAuthorized` 才放行 |

### P0-C · 写操作风险

| 状态 | 任务 | 说明 |
| --- | --- | --- |
| [x] | L0 只读操作定义 | 自动执行 |
| [x] | L1 低风险写入定义 | 可撤销的新建或 AI 草稿修改 |
| [x] | L2 用户已有内容修改定义 | 需要差异预览 |
| [x] | L3 高风险操作定义 | 删除、批量修改、外发、权限变更 |
| [x] | 操作预览显示风险等级 | 预览卡片展示等级和原因 |
| [x] | L2 支持差异预览和确认 | 沿用现有文件操作预览链路 |
| [x] | L2 支持逐条接受或整体接受 | 操作预览维护接受集合，部分接受时重新生成子集计划和 planHash 后执行 |
| [x] | L1 自动执行后显示统一撤销卡片 | `web/src/components/AIAssistantPanel.tsx` 对纯 L1 计划自动执行，回答消息显示执行记录和整批撤销入口 |
| [x] | L3 确认窗口显示完整影响范围 | `web/src/ai/ai-operation-planner.ts` 生成结构化资源、路径、受众、可撤销性范围；`web/src/components/ai/AiOperationPreview.tsx` 展示完整范围并将逐条接受后的子集绑定到确认范围；AI 操作规划器测试通过 |
| [ ] | 跨服务不可撤销操作使用补偿事务 | 适用于外发和第三方连接器 |

### P0-D · WorkspaceService 执行保护

| 状态 | 任务 | 说明 |
| --- | --- | --- |
| [x] | 文件操作执行前快照 | 现有文件内核已支持 |
| [x] | plan hash 校验 | 防止预览后内容发生变化 |
| [x] | 幂等执行入口 | 写操作关闭自动重试并保留操作标识 |
| [x] | 执行后结果校验 | 现有文件操作链路已支持 |
| [x] | 审计日志 | 现有文件操作日志已支持 |
| [x] | 撤销栈 | 现有文件操作支持 undo |
| [x] | 笔记更新乐观锁 | Rust WorkspaceService 已支持版本/哈希校验 |
| [ ] | Agent 写工具全部收口到 WorkspaceService | 接入桌面端 Agent Runtime 后完成 |
| [x] | 多对象写入部分失败恢复 | 文件批处理已返回部分失败结果和 `operationIds`，用户确认后可通过 `file_undo` 逆序补偿；跨服务写入仍未接入 |
| [x] | 2026-10-16 | 后台任务持久化运行状态 | `jobs` 的 `ai-run` 主状态 + `ai_run_events` 事件表；Rust 88 项测试通过 |
| [x] | 2026-10-17 | AI Run 阶段检查点与恢复请求注入 | Schema v10 新增 `jobs.checkpoint`，后台 Run 在生成/完成/失败/取消节点保存阶段元数据；`ai_run_resume` 支持注入当前请求并追加 `resumedFrom`；`cargo fmt --check`、`cargo check --lib`、Rust 89/89、Web 类型检查、构建和 Provider 回归均通过 |

## P1 · Agent 与检索闭环

### P1-A · Agent Runtime

| 状态 | 任务 | 说明 |
| --- | --- | --- |
| [x] | 模型决策接口 | Provider-neutral `AgentModel` |
| [x] | 工具注册接口 | `AgentTool` |
| [x] | Agent Tool Gateway 统一工具 schema、权限复核和幂等执行入口 | `web/src/ai/agent-tool-gateway.ts`、`web/src/lib/ai-agent.ts`；必填参数、viewer 写权限、幂等键和 Gateway 回归测试通过 |
| [x] | 只读工具并行调用 | 同一轮只读调用使用并行执行 |
| [x] | 写工具授权拦截 | L2/L3 在执行前等待授权 |
| [x] | 三重预算控制 | 步数、工具调用次数、token/时间 |
| [x] | 可取消运行 | `AbortSignal` |
| [x] | 接入 Tauri 桌面端模型 Provider | `src-tauri/src/ai_runtime.rs` 使用内存 Provider 配置调用 OpenAI-compatible 流式接口；API Key 不写日志、不落盘 |
| [x] | 接入桌面端流式事件通道 | `ai://stream/{runId}` 事件、取消命令和前端 transport 已接入；真实模型人工验收待补 |
| [ ] | 支持暂停、恢复和断点续跑 | 需要持久化 Run 状态 |
| [x] | 工具重试策略和幂等键统一 | Gateway 统一生成 `runId:callId:tool` 幂等键；幂等工具支持最多 3 次可配置重试、结果校验和并发 in-flight 去重；非幂等工具强制单次执行；跨进程持久化状态仍待接入桌面 Agent Runtime |

### P1-B · 检索管线

| 状态 | 任务 | 说明 |
| --- | --- | --- |
| [x] | 查询改写 | 本地确定性基线清理请求前缀、统一空白并限制查询长度；模型级语义改写仍可替换接入 |
| [x] | 子问题拆分 | 多意图请求拆成最多 4 个子查询，桌面端执行多查询召回后统一融合 |
| [x] | FTS5 召回 | `src-tauri/src/ai/mod.rs`、`src-tauri/src/index.rs`、Tauri 命令 `ai_retrieve` |
| [x] | 向量召回（sqlite-vec-compatible fallback） | `src-tauri/src/ai/embeddings.rs` 生成 64 维离线 Unicode n-gram embedding，v8 投影表保存 hash/维度/向量，`index.rs` 在权限过滤后做余弦召回并纳入 RRF；`sqlite-vec 0.1.10-alpha.4` 因发布包缺失 `sqlite-vec-diskann.c` 无法在当前 Windows 工具链构建，已保留可替换查询边界 |
| [x] | 结构化查询 | 当前 AI 命令复用 folder/inbox 过滤；标签、属性和时间过滤仍待补齐 |
| [ ] | MCP / 联网召回 | 外部来源必须经过授权 |
| [x] | RRF 融合 | `src-tauri/src/ai/retrieval.rs` 融合权限过滤后的 FTS5/LIKE 双路结果 |
| [x] | Rerank 重排 | `src-tauri/src/ai/retrieval.rs` 保留本地确定性词法回退；已支持通过已配置 Provider 调用独立远程小模型，只发送候选标题/短摘要/分数，失败自动回退 |
| [x] | 去重和时间权重 | `src-tauri/src/ai/retrieval.rs` 按 content hash/路径去重、较新副本优先、30 天半衰期时间权重 |
| [x] | 按 token 预算装配上下文 | `web/src/ai/context-builder.ts` 按近似 token 预算装配，保留可信优先级、块级截断和 `truncated` 标记 |
| [x] | 块级引用编号 | `src-tauri/src/ai/mod.rs` 按段落输出 `citationId`、`anchor`、`excerpt`，并标记 `trusted=false` |
| [x] | 引用跳转并高亮原文 | 引用卡片和回答内 `[n]` 可跳转到来源笔记，并定位标题/段落后短暂高亮原文 |

### P1-C · 上下文与会话

| 状态 | 任务 | 说明 |
| --- | --- | --- |
| [x] | 系统指令、工具定义和记忆前缀缓存 | `web/src/ai/context-builder.ts` 对固定可信前缀做本地构建缓存；供应商侧 prompt cache 仍由 Provider 决定 |
| [x] | 检索内容与系统指令分层 | `web/src/ai/context-builder.ts` 将 retrieval/attachment 保持为不可信块，与 system/tool/memory 分离 |
| [x] | 超长会话自动压缩 | `web/src/ai/context-builder.ts` 保留头部约束和最近消息，中间历史压缩为带标记摘要块 |
| [x] | 压缩后保留用户约束和待办状态 | `web/src/ai/context-builder.ts` 在历史压缩块中提取并限量保留用户约束与 Markdown 待办 |
| [x] | 流式展示检索、工具和执行进度 | `web/src/components/AIAssistantPanel.tsx` 将检索状态、服务端 progress、标准化 `tool_call/tool_result` 转为实时步骤；工具完成/失败状态和耗时可见 |
| [x] | 标准流式事件携带首字、工具和总耗时指标 | `web/src/ai/run-telemetry.ts`、`ai-stream-adapter.ts`：事件快照包含 TTFT、总耗时、工具调用次数、工具耗时和终止原因 |
| [x] | 2026-10-16 | 记录首字、工具和总耗时 | `web/src/ai/run-telemetry.ts`、`web/src/ai/ai-stream-adapter.ts`、面板指标回归测试 |

## P2 · 写入体验与长任务

| 状态 | 任务 | 说明 |
| --- | --- | --- |
| [x] | 2026-10-17 | 新建页面和 AI 草稿自动执行 | L1 低风险文件创建/更新计划在面板收到模型动作后自动执行，并显示可撤销结果；`isAutoExecutableL1Plan` 与面板执行链已接入 |
| [x] | 用户已有内容逐条接受 diff | 支持逐条接受或整体接受，并在执行前重新生成被接受子集的计划哈希 |
| [x] | 2026-10-17 | 高风险操作影响范围确认 | 操作规划器和预览卡展示资源、源/目标路径、受众、外部影响和可撤销性，并要求额外确认 |
| [x] | 2026-10-17 | 写入结果跳转到目标位置 | 执行摘要按结果路径提供打开入口，复用现有笔记定位流程 |
| [x] | 2026-10-16 | 后台长任务队列 | `ai_run_enqueue` + Rust `ai-run` worker；关闭面板后事件仍落盘 |
| [x] | 2026-10-16 | 长任务可中断 | `ai_run_cancel`、运行中协作取消和 `ai_run_events` 取消状态 |
| [ ] | 长任务可恢复 | 已增加白名单工具步骤检查点、同一 Run 重试跳过已完成步骤、本地 runId 索引、打开面板扫描和恢复 UI；第一批只读工具额外保存可重放的调用身份与受限参数，并在恢复时重新经过 Gateway 执行；写工具和其他真实工具纳入后台 Runtime、跨进程完整自动接续仍待完成 |
| [x] | 长任务完成通知 | durable Run 按 `runId` 去重；面板不在前台可见时显示统一 Toast，并在浏览器 Notification 已授权时补发系统通知；成功、失败均覆盖，取消保持安静 |
| [x] | 2026-10-17 | 失败任务可重试且不重复写入 | durable 模型失败重试复用同一 `runId` 并走 `ai_run_resume`，保留工具 checkpoint；前台工具失败停留在结果/预览，不自动重复提交；文件批处理已增加 `operationIds` 补偿，跨服务补偿仍待接入 |

## P3 · 记忆、成本与评测

### 2026-10-17 · 桌面通道收口

- 桌面 AI 流式对话与写作助手统一复用 durable Run + Tauri IPC；取消、恢复、事件回放不再经过不存在的 Express 服务。
+ AI 索引状态、手动扫描和文件操作审计历史接入现有 Rust 命令；会话正文仍保持浏览器本地存储边界，不写入 SQLite/checkpoint/durable result。
- IPC 映射/参数/parity、Web typecheck/test/build、Rust lib test 通过；真实模型运行、Ollama 质量样本、三平台构建与签名发布属于外部验收。

### P3-A · 用户记忆

| 状态 | 任务 | 说明 |
| --- | --- | --- |
| [x] | 会话内历史自动压缩 | `web/src/ai/context-builder.ts` 超过阈值后保留头尾、约束和待办，中间历史确定性摘要化 |
| [x] | 用户偏好记忆 | `ai_memories.kind=preference`；设置页仅在用户明确提交后保存 |
| [x] | 工作区知识记忆 | `ai_memories.kind=knowledge`；记忆按工作区本地 SQLite 保存 |
| [x] | 记忆查看、编辑和删除 | 设置页提供列表、编辑、删除；删除后不再注入上下文 |
| [x] | 敏感信息禁止自动记忆 | Rust `MemoryStore` 拒绝密钥、令牌、密码、私钥、邮箱、手机号和身份证号模式；模型没有自动写入命令 |
| [x] | 记忆过期和来源追踪 | `expires_at` 过滤过期注入，设置页显示过期状态、来源、创建和更新时间 |

### P3-B · 成本与延迟

| 状态 | 任务 | 说明 |
| --- | --- | --- |
| [x] | 固定前缀提示缓存 | `web/src/ai/context-builder.ts` 提供本地固定前缀缓存，缓存键绑定权限上下文；供应商侧 Prompt Cache 仍由 Provider 决定 |
| [x] | 查询结果短期缓存 | `web/src/ai/retrieval-cache.ts` 提供 30 秒本地内存缓存和并发请求合并，缓存键绑定权限上下文与内容版本 |
| [x] | 小模型意图判断 | 设置页可从已配置 Provider 选择远程小模型；受限 JSON、超时/错误回退到本地规则；真实延迟样本待配置服务商后补齐 |
| [x] | 小模型 Rerank | 检索后仅发送候选标题、短摘要和分数；受限候选 ID 排序、超时/错误回退到 Rust 词法重排；真实成本/质量样本待配置服务商后补齐 |
| [x] | TTFT、总耗时、token 和成本监控 | `web/src/ai/run-metrics-store.ts` 按 Run 保存 TTFT、总耗时、token、终止原因和可选单价估算；设置页提供本地统计概览 |
| [x] | 任务类型性能基线 | 运行统计按 `quick`、`retrieval`、`agent` 分桶，展示请求量、token 和耗时 P50 |

### P3-C · 可观测与评测

| 状态 | 任务 | 说明 |
| --- | --- | --- |
| [x] | 每次运行记录完整调用链 | `web/src/ai/run-trace-store.ts` 以白名单元数据保存 `run_started`、状态、delta/reasoning、工具调用/结果、确认、引用、错误、done 和 `run_finished`；正文、检索块、附件、密钥和工具结果正文不落盘；面板所有结束路径在 `finally` 收口 |
| [x] | 记录模型、工具、token 和延迟 | 指标记录保存模型、工具次数/耗时、token、TTFT 和总耗时；durable Run 事件保存步骤事件 |
| [x] | 记录预算终止、取消和错误类型 | `AiRunMetrics.terminationReason` 区分 completed/error/cancelled/budget_exceeded |
| [x] | 建立黄金评测集 | `src-tauri/eval/golden-set.json` 固定任务和关键词约束，`metrics-report.mjs` 支持本地回答评分及分类汇总 |
| [x] | 模型或提示词变更前自动回归 | `src-tauri/eval/golden-regression.mjs` 比较基线/候选黄金集报告，默认限制总均分下降 0.05、分类下降 0.10、禁止新增违规命中和缺失答案；失败返回非零退出码 |
| [x] | 记录召回率、引用准确率和写入成功率 | `src-tauri/eval/quality-gate.mjs` 接受离线运行结果，计算三项指标并按默认阈值（0.80/0.90/1.00）给出质量门禁；无对应样本视为不通过 |

## 版本发布检查

| 状态 | 发布条件 | 验证要求 |
| --- | --- | --- |
| [ ] | P0 高风险写操作均有授权和审计 | 自动化测试 + 人工验收 |
| [ ] | P0 权限过滤在检索前生效 | 权限边界测试 |
| [ ] | P1 Agent 循环通过桌面端真实模型验证 | Tauri 运行测试 |
| [ ] | P1 检索结果可解释并可跳转引用 | 引用验收 |
| [ ] | P2 写操作支持预览、执行、校验和撤销 | 完整写入回归 |
| [ ] | 关键路径具备自动化回归测试 | Web + Rust 测试 |
| [ ] | 完成一次人工桌面端验收 | Windows 真实 Vault |
| [ ] | 更新根目录 `更新记录.md` | 版本记录同步 |
| [ ] | 更新产品文档和使用说明书 | 用户文档同步 |
| [ ] | 确定正式版本号并发布 | 发布检查完成 |

## 后续开发记录

| 日期 | 完成内容 | 未完成内容 |
| --- | --- | --- |
| 2026-10-16 | 完成 AI 策略层、Agent Runtime 基础、多意图路由、范围解析、权限过滤接口、风险分级、预算控制、面板元数据接入、风险展示和自动化验证 | 桌面端 Provider、真实检索权限过滤、RRF、Rerank、后台长任务 |
| 2026-10-16 | 完成 Phase 0 领域契约和 Run 状态机；完成 Phase 1 的 Controller、流式事件适配器、Session Store 和操作响应适配器，并接入现有 AI 面板发送/执行链 | AI 面板视图组件拆分、Tauri Provider、真实检索管线和后台任务 |
| 2026-10-16 | 完成 Phase 1 视图拆分并将 Session Store 接入会话刷新、历史恢复、重命名和删除流程；新增独立进度、消息、操作预览、执行摘要和会话历史组件 | 操作预览构建函数仍在面板业务层，Phase 2–5 尚未开始 |
| 2026-10-16 | 建立 Phase 2 Provider 接口、HTTP/Tauri transport 边界和不可信内容分层 ContextBuilder，并加入契约测试 | 真实 Tauri AI 命令、提示缓存、检索管线、Tool Gateway、记忆和评测尚未接入 |
| 2026-10-16 | 新增 Rust `ai_retrieve` 本地检索命令：权限路径在 FTS5/LIKE SQL 召回前过滤，复用 folder/inbox 结构化条件，并输出不可信段落级引用；新增 `/ai/retrieval/preview` 桌面 IPC 路由；AI 检索缺少 `allowedPaths` 时拒绝执行 | sqlite-vec、RRF、Rerank、token 级装配、真实 Tauri 模型流式命令和引用跳转尚未完成；`cargo test --lib` 78/78 通过，新增模块 rustfmt 通过 |
| 2026-10-16 | 清理面板旧内联视图与重复预览逻辑，面板只保留业务编排并复用独立 AI 组件和规划器契约 | 后续推进真实模型人工验收、Agent Tool Gateway、sqlite-vec、RRF、Rerank 和后台任务 |
| 2026-10-16 | 接入 Tauri OpenAI-compatible 流式 Provider：Rust 命令注册、运行 ID 事件隔离、取消信号、前端真实 transport、内存密钥访问器和回归测试 | 真实外部模型桌面端人工验收、Agent Tool Gateway、sqlite-vec、RRF、Rerank、后台任务和长期记忆 |
| 2026-10-16 | 完成 P1 混合检索内核：FTS5/LIKE 在权限与结构化条件过滤后双路召回，使用 RRF 融合、本地确定性词法重排、内容哈希/路径去重、较新副本优先和时间权重；AI 引用返回融合分数与召回来源；新增 83 项 Rust 回归测试 | sqlite-vec、模型级 Rerank、查询改写、子问题拆分、token 级上下文装配和引用跳转尚未完成 |
| 2026-10-16 | 完成上下文 token 预算装配：ContextBuilder 支持模型窗口 80% 或显式预算，按 system/tool/memory → retrieval → history → attachment 顺序装配，超限块截断并保留不可信标记；新增上下文预算回归测试 | 固定前缀提示缓存、超长会话语义压缩、压缩后约束保留和引用跳转尚未完成 |
| 2026-10-16 | 增加 ContextBuilder 固定可信前缀构建缓存和超长历史确定性压缩：缓存 system/tool/memory 前缀，长历史保留头部与最近消息并将中间消息压缩为摘要块；新增缓存命中与压缩回归测试 | 供应商级 prompt cache、模型语义摘要、压缩后约束/待办自动校验和引用跳转尚未完成 |
| 2026-10-16 | 完成引用导航闭环：AI 回答内 `[n]` 和来源卡片携带 `anchor/excerpt` 打开笔记，编辑器与预览区定位对应标题或段落并短暂高亮；新增 Markdown 来源匹配测试 | 供应商级 prompt cache、模型语义摘要、压缩后约束/待办自动校验仍未完成 |
| 2026-10-16 | 完成查询改写与子问题拆分闭环：新增确定性查询规划器，桌面端按最多 4 个子查询执行权限过滤后的多路召回并统一融合；检索块注入模型上下文，无模型引用时生成可跳转引用卡片；新增查询规划器测试 | 模型语义改写、sqlite-vec、MCP/联网召回和供应商级 prompt cache仍未完成 |
| 2026-10-16 | 完成 L1 低风险写入自动执行闭环：纯 L1 计划自动提交，执行结果写入回答元数据并显示统一撤销入口；混合计划、L2/L3 和失败预览继续走差异/确认流程；新增 L1 计划判定回归测试 | L2 逐条接受、L3 完整影响范围确认、后台长任务仍未完成；Web 全量测试、类型检查和生产构建通过 |
| 2026-10-16 | 完成超长历史压缩保护：压缩前从历史中提取去重后的约束与待办，按 8 项上限写入独立可信保护块，并加入 ContextBuilder 回归测试 | 模型语义摘要和用户可编辑的长期记忆仍未完成 |
| 2026-10-16 | 完成 L2 逐条接受闭环：操作预览支持单项接受/取消和整体接受，部分接受时执行前重新预览子集，确保使用匹配的计划哈希；全量 Web 测试、类型检查和生产构建通过 | L3 完整影响范围确认、后台长任务仍未完成 |
| 2026-10-16 | 完成 L3 高风险操作影响范围确认：规划器汇总资源、源/目标路径、受众、外部影响和可撤销性；预览卡展示完整范围，逐条接受后只展示并授权当前子集；操作规划器定向测试、类型检查、全量 Web 测试和生产构建通过 | 后台长任务、跨服务补偿事务和真实桌面端人工验收仍未完成 |
| 2026-10-16 | 完成 Agent Tool Gateway：Agent 工具统一经过 Gateway 执行，支持输入 schema 必填校验、viewer 写权限复核、执行上下文和 `runId:callId:tool` 幂等键；Agent 定向测试、类型检查、全量 Web 测试和生产构建通过 | Gateway 尚未连接所有真实 WorkspaceService/Tauri 写工具，工具级超时/重试策略仍未完成 |
| 2026-10-16 | 建立 MCP/联网结果的不可信上下文协议：新增 `external` 上下文来源，强制 `trusted=false`，保留 provider/origin 元数据并序列化为 `<untrusted_external>`；契约、上下文和全量 Web 测试通过 | MCP/联网实际召回、连接器权限授权和外部内容触发高风险写操作拦截仍未完成 |
| 2026-10-16 | 完成离线向量召回阶段：数据库 Schema v8 增加 `note_embeddings` 投影，扫描/upsert/删除/旧库补建保持 embedding 与内容 hash 同步；向量候选在 SQL 层先应用 `allowedPaths` 和 `folderId`，再做余弦排序并与 FTS5/LIKE 进入 RRF；新增维度校验、hash 更新、删除清理和授权边界回归测试，Rust 单元测试 87/87 通过 | 当前使用 sqlite-vec-compatible Rust fallback；真正 sqlite-vec crate 因上游发布包缺少 `sqlite-vec-diskann.c` 无法构建，待可构建版本或补齐源码后替换；MCP/联网召回、模型级 embedding 和模型级 Rerank 仍未完成 |
| 2026-10-16 | 完成 Agent 执行前安全复核：Gateway 对路径字段执行 Vault 相对路径规范化和 `allowedPaths` 范围匹配，preflight 与 execute 双重复核角色/权限；不可信上下文默认阻断 L2/L3 写工具，只有用户明确授权后才放行；新增越权路径、缺少范围、不可信高风险写入和授权放行测试，Agent 定向测试 6/6、TypeScript 类型检查通过 | MCP/联网实际召回与连接器授权仍未接入；权限缓存键和后台任务状态持久化仍待完成 |
| 2026-10-16 | 完成权限上下文感知缓存：新增检索短期内存缓存，支持 30 秒 TTL、容量上限和并发请求合并；检索键绑定 actor、role、scopeId、permissionVersion、contentVersion 及允许路径，ContextBuilder 固定前缀缓存复用同一权限隔离原则；接入 AI 面板检索入口，新增缓存键隔离、过期和并发合并测试；Web 全量测试、TypeScript 类型检查和生产构建通过 | 当前缓存仅为本地进程内只读缓存；供应商 Prompt Cache、远程连接器 ACL 版本服务、后台任务状态持久化和真实桌面端人工验收仍未完成 |
| 2026-10-16 | 完成标准流式事件运行指标：`AiRunEvent.metrics` 在适配器层携带首个输出块时间（TTFT）、总耗时、工具调用次数、工具耗时和终止原因；新增工具耗时与预算终止回归测试，定向流式测试、TypeScript 类型检查和此前 Web 全量回归通过 | 指标尚未持久化到观测平台，token/cost 统计、黄金评测集和流式检索/工具 UI 进度仍未完成 |
| 2026-10-16 | 完成流式指标与进度 UI 接入：面板接收 `AiRunEvent.metrics` 并写入 assistant message `meta.metrics`，消息元数据显示首字耗时、总耗时和工具次数；`tool_call/tool_result` 转换为任务进度步骤，展示工具执行中、完成、失败和耗时；新增面板契约回归断言，Web 全量测试、TypeScript 类型检查和生产构建通过 | 运行指标仍只随会话消息保存，尚未进入独立观测平台；token/cost 聚合、后台长任务和真实桌面端人工验收仍未完成 |
| 2026-10-16 | 完成后台 AI Run 持久化骨架：复用 SQLite `jobs` 保存 `ai-run` 主状态，新增 `ai_run_events` 追加事件表和 sequence 断点读取；新增 `ai_run_enqueue/get/events/cancel/resume` Tauri 命令、单独后台 worker、启动恢复、有限重试和取消；请求落盘前剥离 API Key，前端新增 durable Run 客户端契约和回归测试；Rust 88/88、Web 类型检查、构建和 AI Provider 测试通过 | 面板仍默认使用前台流式模式；断点级暂停/恢复、系统通知、真实模型桌面端验收、所有真实 WorkspaceService 写工具收口和跨服务补偿事务仍未完成 |
| 2026-10-17 | 增加 AI Run 持久化阶段检查点：Schema v10 为 `jobs` 增加 `checkpoint`，worker 保存生成/完成/失败/取消阶段；恢复 API 支持携带当前请求重新注入内存 Provider，并在事件中返回 `resumedFrom`，不将 API Key 或流式正文写入检查点；`cargo fmt --check`、`cargo check --lib`、Rust 89/89、Web 全量测试、类型检查和生产构建通过 | 工具级最后成功步骤重放、暂停/恢复 UI、系统通知、真实模型桌面端验收、真实 WorkspaceService 写工具收口和跨服务补偿事务仍未完成 |
| 2026-10-17 | 将桌面 AI 面板接入 durable transport：Tauri 请求统一进入 `ai_run` 队列，前端按 `sequence` 增量拉取并回放 `status/delta/reasoning/done/error` 事件；关闭面板不再取消桌面后台 Run，浏览器端仍保留关闭即中止；新增 durable 回放、失败和取消 Provider 测试；Web 全量测试、类型检查和生产构建通过 | 工具级最后成功步骤重放、暂停/恢复 UI、系统通知、真实模型桌面端验收、真实 WorkspaceService 写工具收口和跨服务补偿事务仍未完成 |
| 2026-10-17 | 完成长任务完成通知：面板为每次 Run 绑定 `runId`，成功/失败终态按 Run 去重；面板未在前台可见时显示 Toast，并在浏览器已有通知授权时补发系统通知；取消和等待用户确认不通知；新增通知模块回归测试 | 工具级最后成功步骤重放、暂停/恢复 UI、真实模型桌面端验收、真实 WorkspaceService 写工具收口和跨服务补偿事务仍未完成 |
| 2026-10-17 | 增加工具步骤检查点协议：新增 `ai_run_checkpoint` Tauri 命令并对白名单元数据做长度/阶段/步骤数校验；AI 文件操作在执行前后持久化 `pending/completed/failed`，同一 Run 重试时跳过已完成步骤；新增 Rust 检查点安全测试、Web 工具检查点与 durable client 回归测试；`cargo fmt --check`、`cargo check --lib`、Web 类型检查和定向测试通过 | 启动后自动接续、恢复 UI、跨进程恢复时重新装配当前模型凭据，以及所有真实 WorkspaceService 写工具纳入统一后台执行仍待完成 |
| 2026-10-17 | 增加 durable Run 本地恢复索引：只持久化 `runId/sessionId/createdAt`，面板打开时通过 `ai_run_get` 扫描 queued/running/failed/cancelled 任务；恢复请求读取数据库中的脱敏消息/context，使用当前内存 Provider runtime 注入凭据，并通过 `ai_run_resume` 保留工具 checkpoint；补充恢复/去重/清理测试、Provider 恢复分支测试、类型检查和面板契约断言 | 真实工具纳入后台 Runtime、跨进程工具状态重放和完整自动接续仍待完成；本轮不宣称完整跨重启工具恢复 |
| 2026-10-17 | 完成写入体验收口：L1 新建/草稿动作自动执行后显示可撤销结果；高风险操作展示完整影响范围并要求额外确认；执行摘要支持按目标路径打开笔记；模型失败重试复用原 durable Run，避免创建新 Run 重复提交；定向面板/规划器测试与 TypeScript 检查通过 | 真实工具纳入后台 Runtime、跨进程工具状态重放、多对象补偿事务和完整人工桌面验收仍待完成 |
| 2026-10-17 | 统一 Agent 工具重试与结果校验：幂等工具按 `runId:callId:tool` 共享 in-flight 执行并缓存成功结果，结果校验失败或可重试错误按工具策略重试；非幂等工具即使配置重试也只执行一次；新增 8 项 Agent Gateway 回归测试，类型检查通过 | Gateway 仍为当前进程边界，真实 WorkspaceService/Tauri 工具接入、跨进程步骤状态重放和多对象补偿事务仍待完成 |
| 2026-10-17 | 收紧 durable Run 持久化边界并修复恢复检查点接续：请求 payload 改为白名单元数据，删除附件 data URL、文件正文、检索正文、MCP 配置、headers 和未知字段，仅保留脱敏 provider 参数；恢复前规范化 Rust checkpoint，并按 planHash 复用同一计划的已完成工具步骤，计划变化时重新开始；新增 Rust 载荷脱敏测试和 Web 检查点测试；Web 全量测试、类型检查、构建、Rust 92/92、格式检查通过 | 真实桌面模型与 WorkspaceService Agent Runtime、跨进程工具状态重放、MCP/联网实际召回、多对象补偿事务和人工桌面验收仍未完成 |
| 2026-10-17 | 完成 P3-A 用户可控记忆最小闭环：Schema v11 新增 `ai_memories`，Rust `MemoryStore` 支持 preference/knowledge 的明确保存、编辑、查看、删除、过期过滤和来源追踪；保存边界拒绝常见密钥、令牌、密码、私钥、邮箱、手机号和身份证号模式，模型没有自动写入路径；设置页提供管理界面，AI 面板读取未过期记忆并通过 ContextBuilder 注入可信 memory block；新增 Rust 记忆测试，IPC 路由合约、参数合约、双通道测试和 TypeScript 检查通过 | P3-B 成本/token 监控、任务类型基线，P3-C 完整调用链、golden set、自动回归和质量门禁仍未完成 |
| 2026-10-17 | 完成 P3-B 指标与 P3-C 黄金评测基础：标准 metrics 契约补充 prompt/completion/total tokens 和可选成本估算；模型设置支持输入/输出单价；每次完成 Run 写入本地最多 500 条指标历史，设置页按任务类型和模型展示请求量、token、TTFT/耗时 P50 与成本；重写 `src-tauri/eval/metrics-report.mjs` 为无网络黄金集评分器并新增 Web 回归测试；Web 类型检查、指标测试、黄金集测试和 IPC 合约测试通过 | 完整跨进程调用链归档、模型/提示词变更前自动回归和召回率/引用准确率/写入成功率质量门禁仍未完成 |
| 2026-10-17 | 收口 P3-C 可观测与质量门禁：AI 面板将每次 Run 的开始、规范化流事件、工具调用/结果和终态写入本地白名单追踪；追踪记录包含模型、工具、token、TTFT、耗时和终止/错误元数据，不保存正文；新增 `golden-regression.mjs` 变更前后对比与 `quality-gate.mjs` 召回率/引用准确率/写入成功率门禁，接入 Web 回归测试和根脚本 | 小模型意图判断、小模型 Rerank、真实模型运行样本和最终版本发布检查仍未完成 |
| 2026-10-17 | P3-B 剩余项审计：确认当前意图路由为本地确定性规则、Rerank 为可解释词法基线；本机 Ollama CLI 可用但无已安装模型，仓库 Provider 也没有独立的小模型分类/Rerank 调用边界，因此不将两项误标完成 | 需要选定并配置小模型、接入独立低延迟调用、补齐真实延迟/质量样本后才能完成 P3-B |
| 2026-10-17 | 接入可选远程小模型闭环：设置页复用已配置 Provider 并填写独立小模型 ID；新增受限 `ai_small_model` Tauri 调用，意图判断和 Rerank 严格解析 JSON，失败自动回退；Rerank 仅发送候选标题、短摘要和分数，不发送整篇笔记；新增设置复用、非法输出和候选边界测试；Web 类型检查/全量测试、`cargo check --lib`、Rust 95/95 单元测试和格式检查通过 | 尚未配置真实远程 Provider，故真实延迟、成本和质量样本以及最终版本发布检查仍待完成 |
| 2026-10-17 | 修复桌面模型“测试连接”提示未接入：`/ai/test` 新增 `ai_provider_test` IPC 映射和 Rust 桌面探测命令，支持聊天模型与 embedding，返回真实连通状态/延迟/维度；新增桌面 Provider 测试回归和 IPC 参数契约，桌面开发窗口已自动重启加载修复 | 仍需在桌面窗口用实际 Provider 点击“重新测试”，记录真实服务商结果 |
| 2026-10-17 | 完成低置信度路由澄清交互：本地策略识别“帮我处理一下”等含糊短请求，远程小模型的 `requiresClarification` 也统一进入面板等待状态；用户选择回答、搜索、写作或文件操作后，面板只显示补充方向但将原请求和方向一起发送，避免无意触发 Agent 或写操作；新增路由回归测试，Web 全量测试、TypeScript 类型检查和生产构建通过 | 真实远程 Provider 延迟/质量样本、跨进程工具状态重放、多对象补偿事务和人工桌面验收仍未完成 |
| 2026-10-17 | 重构 AI 工作区为文档式界面：新增本地会话索引与搜索，桌面端无服务端 Session API 时仍可持久化、恢复、重命名和删除话题；修复桌面流式载荷读取 `text` 导致固定显示“已收到请求”的问题；消息区改为正文式回答、浅色纸面、窄导航和固定输入区，并补齐入口兼容层；生产构建成功，AI 会话/策略/Provider/Markdown 定向测试通过 | 浏览器模式仍需启动旧 HTTP 后端才能调用 `/api`，桌面端应使用 Tauri Rust AI runtime；当前分支原有编辑器/IPC 迁移错误仍待单独收口 |
| 2026-10-17 | 将 AI 文件操作的授权边界下沉到 Tauri WorkspaceService：桌面预览/执行请求携带 `actor`、`role`、`allowedPaths`，Rust 侧再次拒绝 viewer、路径越权，并为带 `idempotencyKey` 的 AI 执行在 `.fc/idempotency` 保存结果，重复 Run/重试返回同一结果；补充 IPC 双通道契约和 Rust 单元测试 | 当前环境缺少 `cargo`/`rustc`，本轮 Rust 编译与单元测试未能在本机复核；Web 定向/全量测试通过，TypeScript 仍仅受既有迁移错误阻断 |
| 2026-10-17 | 接入第一批桌面 Provider tool call：Rust 白名单化 `tools` 为 OpenAI-compatible function 描述，限制工具数量、名称、schema 和参数大小；支持流式 `delta.tool_calls` 与旧式 `function_call` 累积解析，并通过结构化 `tool_call/toolCalls` 事件传递到 Web；`lattice_file_operation` 转入现有 AI 操作规划器，继续经过 Gateway、预览、用户确认、allowedPaths、planHash、Rust WorkspaceService 和幂等校验；Web 定向测试、全量测试和生产构建通过 | 工具结果回注模型、其他真实工具、跨进程工具状态重放和本机 Rust 编译复核仍待完成 |
| 2026-10-17 | 完成第一批文件工具结果回注：执行成功后仅提取 `status/path/targetPath/operationId/error` 等脱敏字段，使用新的 continuation Run 将原始 tool call 和结果交给 Rust Provider 组装为 assistant/tool 消息，继续下一轮模型决策；失败或部分执行不自动续写，避免重复动作；新增 Controller continuation 契约测试，Web 定向回归通过 | 其他真实工具、跨进程工具状态重放、多对象补偿事务和本机 Rust 编译复核仍待完成 |
| 2026-10-17 | 接入第一批只读 Provider 工具：新增 `lattice_file_read`、`lattice_note_read`、`lattice_note_search`，复用现有 `file_read` 和 `ai_retrieve` IPC；所有工具标记为 L0/idempotent，必须经过 Agent Gateway 的 `allowedPaths` 范围校验，结果只保留有限正文、路径、引用和 `trusted=false` 等白名单字段，再通过 continuation 回注模型；新增工具权限/边界测试、IPC 路由和参数契约同步，Web 生产构建通过 | 只读工具尚未完成真实 Windows Provider 人工验收；工具级跨重启状态重放、多对象补偿事务、Rust 本机编译复核仍待完成 |
| 2026-10-17 | 完成第一批只读工具的 durable checkpoint 重放：只持久化 `toolName/callId` 与受限的 `path/query/offset/limit`，明确丢弃读取正文和未知参数；模型生成终态但只读 continuation 尚未完成时，恢复索引保留该 Run，重新按当前 workspace、专家和权限版本经过 Gateway 执行后再续写模型；新增 Web checkpoint、只读调用重建和恢复扫描测试，Web 全量测试与生产构建通过 | 写工具及其他工具仍在前端执行边界，完整跨进程工具 Runtime、多对象补偿事务、真实 Windows Provider 人工验收和 Rust 本机编译复核仍待完成 |
| 2026-10-17 | 收紧 durable tool call 持久化：实时流仍向当前面板提供完整参数，但 `ai_run_events` 与 `jobs.result` 只保留调用 ID、工具名及安全路径/查询/数值字段，写入正文和未知参数不落 SQLite；新增 Rust 脱敏回归测试 | 写工具跨重启恢复不保存正文，仍需后台 Runtime 或用户重新提交；多对象补偿事务、真实 Windows Provider 人工验收和 Rust 本机编译复核仍待完成 |
| 2026-10-17 | 完成跨重启恢复边界收口：普通 Run 按原 `runId` 续跑；只读 checkpoint 分类为 `read_replayable`，恢复时重新经过当前 workspace、专家、权限版本和 Gateway；含 `lattice_file_operation` 或文件写操作步骤的 Run 分类为 `write_payload_unavailable`，面板只允许用户重新生成计划并再次确认，不自动执行缺失正文，也不进入 provider continuation；新增恢复分类和混合读写防跳过测试 | 写工具仍未纳入后台 Runtime，多对象补偿事务、真实 Windows Provider 人工验收和 Rust 本机编译复核仍待完成 |
| 2026-10-17 | 补齐后台 Runtime 的工具调用检查点：模型返回 `toolCalls` 后，worker 先保存受限 `tool_execution` checkpoint，再保存脱敏 Run 结果；只读调用保留可重放参数，写调用只保留路径/类型/状态，含写步骤的 completed Run 仍保留在恢复索引并要求重新生成计划；新增 Rust checkpoint 构建测试和 Web completed-write recovery 测试 | 写工具仍由前端 Gateway 执行，尚未下沉为 Rust 后台工具 Runtime；多对象补偿事务、真实 Windows Provider 人工验收和 Rust 本机编译复核仍待完成 |
| 2026-10-17 | 收口后台工具调用状态：模型返回 `toolCalls` 后，AI Job 状态改为 `waiting_confirmation`，只有没有工具调用的 Run 才进入 `completed`；未知工具标记为不可自动重放并要求重新提交，新增 Jobs 状态测试、恢复分类测试和面板提示 | 工具执行仍由前端 Gateway 负责，尚未下沉为 Rust 后台工具 Runtime；多对象补偿事务、真实 Windows Provider 人工验收和 Rust 本机编译复核仍待完成 |
| 2026-10-17 | 完成文件批处理第一阶段补偿协议：Rust `file_execute` 批量动作中途失败时返回 `completed/failed/skipped`、`partialFailure`、批次 `operationIds` 和 `file_undo` 补偿信息；前端持久化检查点只保存补偿 ID，不保存写入正文，撤销按逆序执行并在失败时保留剩余可撤销项；新增 Rust/前端回归测试，Web 定向测试、生产构建和 `cargo check --lib` 通过 | 跨服务/外部连接器的补偿事务仍未接入；Rust 全量单测当前工作树为 98/99，剩余 1 项为既有模板重复内容回归；`cargo fmt --check` 仍受工作树其他文件的既有格式差异阻断 |

| 2026-10-17 | 收紧 durable Run 操作结果脱敏：`actions/operations/results` 等集合只保留操作 ID、类型、路径、状态、错误和撤销 ID，写入正文、读取结果正文与未知参数不进入 SQLite durable result；修复 frontmatter 正文边界并新增回归测试；Rust 全量单测 100/100 通过 | 写工具跨重启仍不保存正文，跨服务补偿事务、真实 Windows Provider 人工验收和 TypeScript 既有迁移错误仍待完成 |
| 2026-10-17 | 接入桌面更新检查与 Vault 图片资源边界：新增 Rust `update_check`，只读请求 GitHub Releases 并校验 GitHub HTTPS 地址；新增 `VaultImage` 和 Markdown 预览 Blob IPC 替换，桌面端不再依赖旧本地 HTTP 图片 URL；Rust 单测 104/104、Web 全量测试、类型检查和 IPC 契约通过 | 自动安装更新、MCP sidecar、真实 Provider 运行态验收和签名发布仍待完成 |
