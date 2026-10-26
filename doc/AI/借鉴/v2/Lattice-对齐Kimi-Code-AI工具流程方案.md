# Lattice 对齐 Kimi Code AI 工具流程方案（对齐 v2）

> 来源：`doc/AI/借鉴/v1/Kimi-Code-AI工具完整流程.md`（v1，2026-10-26，347 行）
> 日期：2026-10-26 · 分支：`phase/p1-rust-ai` · 状态：**审计完成，待批次授权**
> 用途：把 v1 参考文档的 15 节机制逐节对照 Lattice ai-core 现状，修正 v1 §14 映射表的过时行，产出缺口清单与落地批次建议。
> 硬约束：**图表区域不动**（见 §8）。

---

## 0. 执行摘要

v1 参考文档描述了 Kimi Code Desktop 代理的真实运行机制，共 15 节。本次对齐审计发现：

1. **Lattice ai-core 已完成约 70% 的机制对齐**——agent loop（§2）、权限分层（§7）、上下文压缩（§8）、交付标准（§14）均有文件级实现，且多数带双侧夹具互证（`risk-classification.json`、`context-serialization.json`）。
2. **v1 §14 映射表有 2 行过时**——技能（§6）与系统提示骨架（§3）的"尚无/散落字符串"描述与当前代码不符（E1 已完成、PromptRegistry 已版本化）。本文档 §2 予以勘误。
3. **真正未对齐的增量在三块**：子代理机制（§5，完全缺失）、会话内异步机制（§9 的 cron 与后台任务语义）、系统提示"宪法骨架"的显式建模（§3 九章）。这三块是本方案建议的落地主体。
4. **图表区域（关系图谱 + 画布 + BlockSuite 编辑器）与 ai-core 零交集**，对齐工作不会触碰这些组件（见 §8）。

---

## 1. 参考文档结构速览（v1 的 15 节）

| 节 | 主题 | 一句话 |
|---|---|---|
| §0 | 一句话概括 | 模型想、工具做、带终止条件的循环反复配合 |
| §1 | 分层架构 | 宿主 / 代理循环 / 模型服务 / 本地执行面 |
| §2 | Agent Loop 七步 | 接收→组装→推理→判终止→执行→回注→循环 |
| §3 | 系统提示骨架（9 章宪法） | 身份/沟通/工具使用/编码规范/风险动作/交付标准/上下文管理/技能/子代理 |
| §4 | 工具体系 | 18 类工具 + 5 条调用硬规则 |
| §5 | 子代理机制 | coder/explore/plan、冷启动、结果回父、授权门槛 |
| §6 | 技能机制 | 三级作用域 + 运行期刷新 + 强制调用 |
| §7 | 权限安全模型 | 权限模式、分层过滤、L 级风险、拒绝不可绕路 |
| §8 | 上下文管理与记忆 | 压缩保结论丢状态、跨会话持久化、预算隐性成本 |
| §9 | 会话内异步机制 | 后台任务合成消息、WaitFor 语义、cron（jitter/合并/7 天/50 上限） |
| §10 | 浏览器工具流程 | 内置浏览器协议（桌面应用不适用） |
| §11 | 完整流程时序 | 计划模式→探索→批准→TDD→实现→验证→收尾 |
| §12 | 可观测性 | 会话日志、后台任务 output_path、任务快照 |
| §13 | 边界与不可靠之处 | 模型不自报版本、无视觉、Bash 无守卫等 7 条 |
| §14 | 对 Lattice ai-core 的借鉴映射 | Kimi 机制→Lattice 对应层→借鉴要点（**本方案的主要勘误对象**） |
| §15 | 验证清单 | v1 文档自身的可信度说明 |

---

## 2. v1 §14 映射表勘误（先修正基准，再谈对齐）

v1 §14 的映射表写于 E 系列开工之前，以下行与当前代码不符，本方案以此为准：

| v1 §14 原文 | 勘误后事实（2026-10-26 代码现状） |
|---|---|
| 系统提示骨架 → "`ai/core/prompt` … Lattice 现状：散落字符串，无版本" | **已过时**。`PromptRegistry`（`src-tauri/src/ai/core/prompt/mod.rs`）已版本化：frontmatter（id/version/vars）、4 个内置模板（assistant.welcome / small.intent / small.rerank / write.polish）、`<Vault>/.lattice/prompts/*.md` 覆盖、渲染 fail-fast 占位校验。**剩的缺口是"九章宪法骨架"没有显式建模**（见 §3 审计）。 |
| 技能 → "尚无" | **已过时**。E1 已落地：`ExpertRuntime`（`src-tauri/src/ai/core/expert.rs`）含 `SKILL_LOAD_TOOL`、用户显式调用的 `invokedSkills`（≤8 条、单条 ≤8000 字、总 ≤24000）、渐进披露三级（目录常驻 / skill_load 加载 / references 深读）、`runtime_guard` 防模型自称。**剩的缺口是"强制调用"与"作用域优先级"**（见 §6 审计）。 |
| 子代理 → "尚无" | **仍然成立**。无任何子代理实现。 |
| cron/后台任务 → "durable run" | **部分成立**。durable run（关面板循环不断）已实现（`web/src/ai/run-recovery.ts` 恢复分类 + 本地索引），但 cron 调度与"后台任务完成通知=合成事件"语义未实现。 |

---

## 3. 逐节对齐审计

对齐度口径：**已对齐**＝机制有实现且行为正确；**部分对齐**＝主干有、缺关键细节；**未对齐**＝无实现；**N/A**＝桌面应用不适用。

### §1 分层架构 —— 已对齐

| Kimi 层 | Lattice 对应 | 证据 |
|---|---|---|
| 宿主应用（聊天界面、会话持久化、权限弹窗） | 桌面壳 + web（`web/src/ai/`） | `AiController`/`AiRunEvent` 契约（`web/src/ai/contracts.ts`） |
| 代理循环 | `ai/runtime` + `ai/core/agent` | `run_worker.rs`（`AiRuntimeState`：active/pending_requests/pending_writes/kernel_continuations）、`chat.rs`（`stream_provider_round`） |
| 模型服务（无副作用） | `ai/core/provider`（协议层/OpenAI 兼容） | `provider/protocol/openai.rs`、`catalog/`、`discovery.rs` |
| 本地执行面 | `ai/core/agent/tools.rs` + IPC | 7 个内置工具 + MCP 工具面（`core/mcp/mod.rs`） |

v1 §1.2 的关键约束均有对应：工作目录锚定（内核工具只接受 Vault 相对路径，`agent-tool-gateway.ts:76` 路径归一化拒绝绝对路径/`..`）；"无隐藏状态、改前先读"（§4 审计）。

### §2 Agent Loop —— 已对齐（1 处细节缺口）

| Kimi 机制 | Lattice 实现 | 证据 |
|---|---|---|
| 七步循环 | `stream_provider_round` 多轮循环 | `src-tauri/src/ai/runtime/chat.rs`（SSE 解析、think 剥离、tool_calls 累积、TTFT） |
| 并行/串行分流 | 读并行 ≤4（`MAX_PARALLEL_READS`）、写串行 | `src-tauri/src/ai/core/agent/runner.rs` `plan_execution` |
| 终止条件 | 无工具调用→收尾；预算/角色/scope 闸；用户取消协作 | `runner.rs`（预算闸 + 角色禁写 + scopeExclude）、`chat.rs`（取消协作） |
| 结果回注 | 工具结果结构化回注为下一轮输入 | `runner.rs`（toolResults 累积）、`contracts.ts`（`AiRunEvent.tool_result`） |
| 结果截断 | `MAX_RESULT_CHARS=4000`，失败转 `{status:"failed",error}` 不中断 run | `core/agent/tools.rs` |

缺口（细节级）：§2.2 终止条件第 3 条"后台任务失败/超时且无法继续→如实汇报"无对应——Lattice 尚无后台任务类型，属 §9 缺口的连带项。

### §3 系统提示骨架（九章宪法）—— 部分对齐（本次对齐的重点增量之一）

**已有**：PromptRegistry 版本 + 覆盖机制（frontmatter id/version/vars、内置模板、`.lattice/prompts/*.md` 覆盖、fail-fast）。

**缺**：九章没有显式建模为"骨架模板"。当前 4 个内置模板都是通用片段（欢迎语/意图分类/重排/润色），缺：

| 宪法章 | 现状 |
|---|---|
| 身份与目标 | 助手提示里有，无版本化骨架 |
| 沟通规范（Markdown、匹配用户语言、路径带行号） | 部分（web 渲染支持），无骨架条目 |
| 工具使用（专用工具优先、独立调用并行） | **缺**（§4 硬规则的连带项） |
| 编码规范（贴合周边、先查 manifest、不加无谓注释） | **缺** |
| 风险动作（可逆自由做、难撤销先确认、被拒不绕路） | 机制有（WriteGate），但无骨架条目显式约束模型 |
| 交付标准（构建+测试通过+端到端跑通） | 机制有（`npm run verify` 六段门禁），模型侧无显式提示 |
| 上下文管理（压缩后信摘要但瞬时状态用工具重确认） | **缺**（§8 连带项） |
| 技能机制（匹配即强制调用） | **缺**（§6 连带项） |
| 子代理规则（用户未要求不派发） | **缺**（§5 连带项） |

### §4 工具体系 —— 部分对齐

**已有**：
- 工具面：`ToolRegistry` 7 内置（file_read / note_read / note_search / file_grep / file_list / skill_load / file_operation，`core/agent/mod.rs`）+ MCP 工具面（`mcp__<server>__<tool>` 命名、注解缺省按高风险、server 上限 8、单 server 40、总量 40，`core/mcp/mod.rs`）。
- 执行门面：`agent-tool-gateway.ts` 预检→执行→幂等→重试→路径范围校验→不可信上下文写保护（untrustedContext + L2/L3 写需 `externalWriteAuthorized`）。
- 风险分级：L0–L3（`risk.rs` + `ai-policy.ts` 双侧夹具互证）。

**缺（§4.2 五条硬规则的显式化）**：
1. "专用工具优先于裸 shell"——Lattice 内核**只有结构化工具、无裸 shell 面**（比 Kimi 更安全），但这条原则没有写进系统提示/工具面约束。
2. "Read 是 Edit 的前提"——`file_operation` 直接写，无"写前必须读"的强制校验。
3. "Bash 无守卫靠自律"——不适用（无 Bash 面），天然免疫。
4. "权限拒绝不可绕过"——机制有（WriteGate 三态），模型侧无显式提示。
5. "后台任务诚实性"——§9 缺口连带。

### §5 子代理 —— **未对齐（最大增量）**

v1 §5 的全部机制无对应：coder/explore/plan 类型、冷启动上下文、结果只回父、不重复劳动、前台/后台、resume、swarm、**授权门槛（用户要求 / AGENTS.md 或技能指示 / 多代理模式，三者之一才算授权）**。

### §6 技能 —— 部分对齐

**已有**（E1）：SKILL.md 开放标准、渐进披露三级、`skill_load` 内核工具、用户 `/` 面板显式调用（invokedSkills）、`runtime_guard` 防模型自称。

**缺**：
- **强制调用**：技能匹配时"必须调用"的约束只存在于工具面，没有系统提示级/内核级强制（Kimi 是阻塞要求）。
- **作用域优先级**：Project > User > Extra > Built-in 四级作用域未实现（当前无优先级概念）。
- **运行期动态刷新 + DISREGARD 提示**：无（技能清单在请求期固化）。

### §7 权限安全 —— 已对齐

| Kimi 机制 | Lattice 实现 | 证据 |
|---|---|---|
| 权限模式 | approvalPolicy 三档（always/review/skip）+ allowIrreversible 高危豁免 | `ai-controller.ts:19-24` |
| 风险分级 | L0–L3 + reversible + requiresConfirmation | `risk.rs` / `ai-policy.ts` |
| 写前置检查 | WriteGate L0–L3（Auto/NeedsConfirmation/Granted），**L3 永不免** | `runner.rs`、`expert.rs` WritePolicy |
| 角色禁写 | viewer 角色不能执行写工具 | `agent-tool-gateway.ts:226` |
| 路径范围 | 工具调用必须在 `allowedPaths` 内，绝对路径/`..` 拒绝 | `agent-tool-gateway.ts:76-108` |
| 不可信上下文 | retrieval/attachment/external 块 `trusted=false`，不可信内容不能驱动 L2/L3 写 | `contracts.ts:121`、`agent-tool-gateway.ts:105` |
| 拒绝不可绕路 | 内核预检 + 网关预检双层，失败即拒 | `runner.rs` + `agent-tool-gateway.ts` |

### §8 上下文管理 —— 部分对齐

**已有**：`ContextComposer` 块序（system→tool→memory→retrieval→history→attachment→external）、UTF-16 口径（4 单位=1 token）、>12 条历史压缩（首二 + 保留块 + 摘要 + 尾四）、与 web `serializeAiContext` 字节级互证（夹具 `tests/fixtures/context-serialization.json`）。

**缺**："摘要保结论丢状态、压缩后瞬时状态必须用工具重新确认"没有写进压缩规范/系统提示（v1 §13.5 指出这是实践出错率最高的规则）。子代理的"上下文预算隔离"机制也缺（§5 连带）。

### §9 会话内异步机制 —— 部分对齐（第二大增量）

**已有**：durable run——关面板循环不断，本地索引 + 恢复分类（`run-recovery.ts`：run_resume / read_replayable / write_confirmation_required / write_payload_unavailable / tool_replay_unavailable，写体永不自动重放）。

**缺**：
- **cron 调度**：完全未实现（5 段 cron、jitter 防羊群、coalescedCount 合并、recurring 7 天过期 + stale 标志、活跃会话 50 上限）。
- **后台任务"合成消息"语义**：run 事件类型（`contracts.ts`）无后台任务类型；"完成通知是合成用户消息、未收到结果不得声称完成"无对应。
- **WaitFor 语义**：无（等待规则：不空等自己刚启动的任务、超时非错误、完成只通知一次）。

### §10 浏览器工具 —— N/A

桌面应用无浏览器工具面。Kimi 的"用户要求自己的浏览器时改用 kimi-webbridge"约束在 Lattice 无对应需求。

### §11 完整流程时序 —— 部分对齐

**已有**：交付标准落地（v1 §11 第 7 步"用项目自身的验证命令"＝`npm run verify` 六段门禁：fc / typecheck / web 测试 / 夹具 / eval:gate / cargo test）。

**缺**：计划模式（EnterPlanMode/ExitPlanMode 的批准流）、TodoList 式进度面板、TDD 工具流——web 循环已退役（W7），这些属于产品级交互，建议只做文档映射不实现工具。

### §12 可观测性 —— 部分对齐

**已有**：`ai_trace` 表（run 维度：provider/model/TTFT/tokens/cost/专家/提示词版本，按 task_type 聚合 P50/P95，`core/trace/mod.rs`）；web 侧 `run-trace-store` / `run-metrics-store`。

**缺**：会话级事件日志（Kimi 的 `wire.jsonl` 对应物）；后台任务 `output_path` 概念（§9 连带）。

### §13 边界 —— 基本对齐

多数自然成立（桌面端、无 Bash 面即免疫"Bash 无守卫"）。需显式落实的只有："压缩后状态重建是显式步骤"（§8 连带）。

### §14 交付标准 —— 已对齐

"构建+测试在交付物上通过 + 端到端场景跑通"＝`npm run verify` 六段门禁；"代码写完≠完成"由 eval:gate（回归门禁 + 密钥扫描）兜底。

---

## 4. 缺口汇总（按优先级）

| 优先级 | 缺口 | 出处 | 性质 |
|---|---|---|---|
| **P0** | 子代理机制（类型、冷启动、结果回父、授权门槛） | §5 | 完全缺失，新机制 |
| **P0** | cron 调度器（jitter / coalescedCount / 7 天过期 / 50 上限） | §9.3 | 完全缺失，新机制 |
| **P1** | 系统提示"宪法骨架"九章显式建模（版本化模板） | §3 | 增量，复用 PromptRegistry |
| **P1** | 后台任务合成消息语义 + WaitFor 语义 | §9.1/9.2 | 增量，需事件模型扩展 |
| **P1** | 工具设计学硬规则显式化（专用工具优先、Read 是 Edit 前提、拒绝不绕路） | §4.2 | 文档 + 内核校验 |
| **P2** | 技能强制调用 + 四级作用域优先级 | §6 | 增量 |
| **P2** | 压缩规范"摘要保结论丢状态"写入系统提示/压缩规则 | §8 | 文档 + 提示 |
| **P2** | 会话级事件日志（wire.jsonl 对应物） | §12 | 增量 |

---

## 5. 落地批次建议（A 系列，沿用 W/U/E 命名法）

| 批次 | 内容 | 涉及模块 | 依赖 | 估时 |
|---|---|---|---|---|
| **A1** | 系统提示宪法骨架：把 §3 九章建模为 PromptRegistry 的骨架模板（9 章各一模板，frontmatter 版本化，`.lattice/prompts/` 可覆盖），与 §4.2 硬规则、§8 压缩规范合并成一份"代理宪法"文档落 `.lattice/prompts/` | `core/prompt/` + 模板目录 | 无 | ~1 周 |
| **A2** | 子代理机制（先只读 explore 型）：子代理类型（explore：只读工具面子集）、冷启动 prompt 组装、结果只回父的通道、**授权门槛显式化**（用户请求 / 专家绑定 / 设置开关，三者之一）、预算继承与收紧 | `core/agent/`（新增 `subagent.rs`）、`runtime/` | A1（宪法骨架里的子代理章） | ~2 周 |
| **A3** | cron 调度器：5 段 cron + jitter、coalescedCount 合并语义、recurring 7 天 stale 过期、50 上限、run 事件新增 cron 触发类型 | `runtime/`（新增 `scheduler.rs`）、`contracts.ts` | 无 | ~1.5 周 |
| **A4** | 后台任务语义：run 事件新增后台任务类型、"合成消息"完成通知、WaitFor 语义、`output_path` 截断引用 | `contracts.ts`、`chat.rs`、`run_worker.rs` | A3 | ~1 周 |
| **A5** | 工具硬规则内核化：`file_operation` 写前读校验（Read 是 Edit 前提）、拒绝不可绕路的内核级提示注入 | `core/agent/tools.rs`、`runner.rs` | A1 | ~0.5 周 |
| **A6** | 技能强化：强制调用系统提示约束、作用域优先级（项目 > 用户 > 内置） | `core/expert.rs`、`core/prompt/` | A1 | ~1 周 |
| **A7** | 可观测性：会话级事件日志落盘 + 后台任务 output_path 引用 | `core/trace/`、`runtime/` | A4 | ~0.5 周 |

**批次原则**（沿用执行方案约定）：一个批次一个 PR；双侧夹具不新增豁免；每批合入后更新本文 §6 执行日志与 §14 对齐表。

---

## 6. 图表区域不动清单（硬约束）

本次对齐工作（A1–A7 全部批次）**只触及 ai-core 与 AI 输出层**，以下"图表区域"组件一律不动：

| 文件 | 区域 |
|---|---|
| `web/src/components/GraphView.tsx` | 关系图谱（原生 Canvas 力导向） |
| `web/src/components/CanvasView.tsx` | 画布（Obsidian 风格卡片 + 连线） |
| `web/src/editor/BlockSuiteEditor.tsx` | BlockSuite 编辑器 |
| `web/src/editor/BlockSuiteEdgelessCanvas.tsx` | BlockSuite 白板画布 |
| 上述组件的样式（`graph*` / `canvas*` CSS） | 视觉呈现 |

对齐工作范围：`src-tauri/src/ai/**`（内核）、`web/src/ai/**`（AI 输出层）、`web/src/lib/ai-*.ts`（策略层）、`web/src/api/ai.ts`（契约）——与图表区域零交集。

---

## 7. 验证清单

- [x] 参考文档 v1 的 15 节全部逐节审计（§3）
- [x] v1 §14 映射表过时行勘误（§2）
- [x] 每节对齐度均有文件级证据（章节内表格）
- [x] 图表区域不动清单明确（§6）
- [x] 落地批次依赖关系明确、估时给出（§5）
- [ ] A1–A7 批次授权后逐批实施，每批更新执行日志
