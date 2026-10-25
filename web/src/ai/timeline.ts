/**
 * UnifiedTimeline 合并（U2）：把任务模式的三块执行记录——
 * `meta.progress`（步骤/工具运行态）、`meta.toolExecutions`（运行时工具记录）、
 * `meta.executed/executedFailed`（已执行操作摘要）——合成**单一时间线**。
 *
 * 合并序（夹具钉死，web/test/ai-timeline.test.mjs）：
 * 1. progress 步骤按既有顺序全量进入；
 * 2. toolExecutions 中未被 progress 覆盖的条目（id 不为 `tool-{callId}` 形态）
 *    按原顺序追加在其后——进度与运行时记录来自两套事件源，合并不丢事件；
 * 3. executed / executedFailed 摘要按原顺序殿后（失败红）。
 * 图标归类：label/payload 推断 search / read / write / mcp / step / execution。
 */

export interface AiProgressStep {
  id: string;
  label: string;
  status?: string;
  detail?: string;
}

export interface AiToolExecution {
  kind?: string;
  server?: string;
  tool?: string;
  label?: string;
  transport?: string;
  ok?: boolean;
  error?: string;
}

export type AiTimelineKind = 'search' | 'read' | 'write' | 'mcp' | 'step' | 'execution';

export interface AiTimelineEntry {
  id: string;
  kind: AiTimelineKind;
  label: string;
  detail?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'waiting';
  ok?: boolean;
}

export interface AiTimelineInput {
  progress?: AiProgressStep[];
  toolExecutions?: AiToolExecution[];
  executed?: string[];
  executedFailed?: string[];
}

const READ_TOOLS = ['read', 'list', 'grep', 'find', 'history'];
const SEARCH_TOOLS = ['search', 'retrieve', 'query'];
const WRITE_TOOLS = ['operation', 'write', 'create', 'update', 'delete', 'move', 'copy', 'execute'];

function statusOf(value: string | undefined, fallback: AiTimelineEntry['status']): AiTimelineEntry['status'] {
  if (value === 'completed' || value === 'failed' || value === 'running' || value === 'waiting' || value === 'pending') {
    return value;
  }
  return fallback;
}

/** 从工具名/标签推断图标类别；记录自带 kind（search/read/write/mcp）时直接采信。 */
export function classifyToolKind(name: string | undefined, kind: string | undefined): AiTimelineKind {
  if (kind === 'mcp') return 'mcp';
  if (kind === 'search' || kind === 'read' || kind === 'write') return kind;
  const raw = String(name ?? kind ?? '').toLowerCase();
  if (SEARCH_TOOLS.some((token) => raw.includes(token))) return 'search';
  if (WRITE_TOOLS.some((token) => raw.includes(token))) return 'write';
  if (READ_TOOLS.some((token) => raw.includes(token))) return 'read';
  return raw.startsWith('lattice_') ? 'read' : 'step';
}

function toolLabel(execution: AiToolExecution): string {
  if (execution.kind === 'mcp') return `MCP ${execution.server ?? '?'} / ${execution.tool ?? '?'}`;
  const prefix = execution.kind === 'search' ? '检索' : execution.kind === 'write' ? '写入' : '读取';
  return `${prefix} ${execution.label ?? execution.tool ?? ''}`.trim();
}

export function buildAiTimeline(input: AiTimelineInput): AiTimelineEntry[] {
  const entries: AiTimelineEntry[] = [];
  const coveredToolCallIds = new Set<string>();
  for (const step of input.progress ?? []) {
    const id = String(step?.id ?? '');
    // progress 里的运行态工具步骤 id 形如 `tool-{callId}`（mergeRuntimeToolProgress 约定）
    if (id.startsWith('tool-')) coveredToolCallIds.add(id.slice('tool-'.length));
    const isToolStep = id.startsWith('tool-');
    entries.push({
      id: id || `step-${entries.length}`,
      kind: isToolStep
        ? classifyToolKind(String(step.label ?? '').replace(/^工具：/, ''), undefined)
        : 'step',
      label: String(step.label ?? '步骤'),
      detail: step.detail ? String(step.detail) : undefined,
      status: statusOf(step.status, isToolStep ? 'completed' : 'pending'),
    });
  }
  for (const execution of input.toolExecutions ?? []) {
    const callId = String((execution as { callId?: string }).callId ?? execution.label ?? entries.length);
    if (coveredToolCallIds.has(callId)) continue;
    entries.push({
      id: `exec-${callId}-${entries.length}`,
      kind: classifyToolKind(execution.tool ?? execution.label, execution.kind),
      label: toolLabel(execution),
      detail: execution.transport === 'stdio'
        ? '本地 MCP 进程'
        : execution.transport === 'sse'
          ? 'MCP 网络服务'
          : undefined,
      status: execution.ok === false ? 'failed' : 'completed',
      ok: execution.ok !== false,
    });
  }
  for (const [index, item] of (input.executed ?? []).entries()) {
    entries.push({
      id: `done-${index}`,
      kind: 'execution',
      label: String(item),
      status: 'completed',
      ok: true,
    });
  }
  for (const [index, item] of (input.executedFailed ?? []).entries()) {
    entries.push({
      id: `done-failed-${index}`,
      kind: 'execution',
      label: String(item),
      status: 'failed',
      ok: false,
    });
  }
  return entries;
}
