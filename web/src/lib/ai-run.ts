export type AiRunMode = 'quick' | 'task';
export type AiRunStageStatus = 'idle' | 'running' | 'completed' | 'waiting' | 'failed' | 'skipped';

export interface AiRunProgressStep {
  id: string;
  label: string;
  status?: string;
  detail?: string;
}

export interface AiRunStage {
  id: string;
  label: string;
  detail: string;
  status: AiRunStageStatus;
}

export interface AiRunInput {
  mode: AiRunMode;
  sending: boolean;
  streamText: boolean;
  reasoning: boolean;
  hasAnswer: boolean;
  hasReferences: boolean;
  hasTools: boolean;
  hasPreview: boolean;
  hasExecution: boolean;
  failed: boolean;
  contextLabel: string;
  pageCount: number;
  webSearch: boolean;
  progress?: AiRunProgressStep[];
}

function stageStatus(input: AiRunInput): 'idle' | 'running' | 'completed' {
  if (input.failed) return 'failed' as never;
  return input.sending ? 'running' : input.hasAnswer || input.hasExecution || input.hasPreview ? 'completed' : 'idle';
}

/**
 * Convert the request lifecycle into a small, explainable operator view.
 * The function deliberately only consumes client state, so it stays useful
 * while the server is streaming and remains easy to cover with unit tests.
 */
export function buildAiRunStages(input: AiRunInput): AiRunStage[] {
  const activeProgress = input.progress?.find((step) => ['running', 'pending'].includes(String(step.status ?? '')));
  const retrievalRunning = input.sending && !input.streamText && !input.reasoning;
  const synthesisRunning = input.sending && (input.streamText || input.reasoning);
  const hasRetrievalResult = input.hasAnswer || input.hasReferences || input.hasPreview || input.hasExecution;
  const hasSynthesisResult = input.hasAnswer || input.hasExecution;

  return [
    {
      id: 'intent',
      label: '意图判断',
      detail: input.mode === 'task' ? '任务模式 · 工具调用可用' : '快速问答 · 只读优先',
      status: stageStatus(input),
    },
    {
      id: 'context',
      label: '上下文与权限',
      detail: `${input.contextLabel} · ${input.pageCount} 个页面 · 写入需确认`,
      status: input.failed ? 'failed' : 'completed',
    },
    {
      id: 'retrieval',
      label: '按需检索',
      detail: input.webSearch ? 'FTS5 · sqlite-vec · 网页搜索' : 'FTS5 · sqlite-vec',
      status: input.failed ? 'failed' : retrievalRunning ? 'running' : hasRetrievalResult ? 'completed' : 'idle',
    },
    {
      id: 'synthesis',
      label: '上下文组装与生成',
      detail: input.hasReferences ? `回答 · ${input.hasReferences ? '带引用' : '无引用'}` : '模型流式生成',
      status: input.failed ? 'failed' : synthesisRunning ? 'running' : hasSynthesisResult ? 'completed' : 'idle',
    },
    {
      id: 'tools',
      label: '工具调用',
      detail: input.mode === 'task'
        ? activeProgress?.detail || activeProgress?.label || '按需读取文件与连接器'
        : '快速模式不自动写入',
      status: input.failed
        ? 'failed'
        : input.mode !== 'task'
          ? 'skipped'
          : activeProgress
            ? 'running'
            : input.hasTools || input.hasPreview || input.hasExecution
              ? 'completed'
              : 'idle',
    },
    {
      id: 'review',
      label: '计划、预览与风险',
      detail: input.hasPreview ? '计划已生成 · 等待用户确认' : '写操作先预览，敏感路径追加确认',
      status: input.failed ? 'failed' : input.hasPreview ? 'waiting' : input.hasExecution ? 'completed' : 'idle',
    },
    {
      id: 'execute',
      label: 'WorkspaceService 执行',
      detail: input.hasExecution ? '快照已创建 · 操作已提交' : '尚未执行任何写操作',
      status: input.failed ? 'failed' : input.hasExecution ? 'completed' : input.hasPreview ? 'waiting' : 'idle',
    },
    {
      id: 'audit',
      label: '校验、审计与撤销',
      detail: input.hasExecution ? '结果已校验 · 支持撤销' : '执行后写入审计日志',
      status: input.failed ? 'failed' : input.hasExecution ? 'completed' : 'idle',
    },
  ];
}
