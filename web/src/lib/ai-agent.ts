import { classifyAiWriteRisk, type AiAgentBudget, type AiRiskLevel, type AiWriteAction } from './ai-policy.ts';
import { createAgentToolGateway, type AgentPermissionScope, type AgentToolGateway, type AgentToolGatewayContext } from '../ai/agent-tool-gateway.ts';

export type AgentToolKind = 'read' | 'write';

export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentTool {
  name: string;
  kind: AgentToolKind;
  description?: string;
  riskLevel?: AiRiskLevel;
  inputSchema?: Record<string, unknown>;
  timeoutMs?: number;
  supportsUndo?: boolean;
  idempotent?: boolean;
  retry?: {
    /** Total attempts, including the initial call. Non-idempotent tools are capped at one. */
    maxAttempts?: number;
    backoffMs?: number;
    retryable?: (error: unknown) => boolean;
  };
  /** Return true/string on success; return false or an error message on invalid output. */
  validateResult?: (value: unknown) => boolean | string;
  permission?: {
    pathFields?: string[];
    requiresScope?: boolean;
  };
  execute: (input: Record<string, unknown>, context: {
    signal: AbortSignal;
    call: AgentToolCall;
    runId?: string;
    actor?: string;
    role?: string;
    idempotencyKey?: string;
    attempt?: number;
  }) => Promise<unknown>;
}

export interface AgentDecision {
  type: 'answer' | 'tool_calls' | 'clarify';
  answer?: string;
  question?: string;
  calls?: AgentToolCall[];
  usage?: { totalTokens?: number };
}

export interface AgentObservation {
  call: AgentToolCall;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AgentModelContext {
  step: number;
  observations: AgentObservation[];
  signal: AbortSignal;
}

export interface AgentModel {
  decide: (context: AgentModelContext) => Promise<AgentDecision>;
}

export interface AgentRunEvent {
  type: 'started' | 'step' | 'tool-start' | 'tool-result' | 'awaiting-confirmation' | 'budget' | 'completed' | 'failed';
  step?: number;
  call?: AgentToolCall;
  observation?: AgentObservation;
  message?: string;
  budget?: AiAgentBudget;
}

export interface AgentRunOptions {
  model: AgentModel;
  tools?: AgentTool[];
  toolGateway?: AgentToolGateway;
  budget: AiAgentBudget;
  signal?: AbortSignal;
  allowRisk?: AiRiskLevel;
  runId?: string;
  actor?: string;
  role?: string;
  permissionScope?: AgentPermissionScope;
  untrustedContext?: boolean;
  authorizeWrites?: (calls: AgentToolCall[]) => Promise<boolean>;
  onEvent?: (event: AgentRunEvent) => void;
}

export interface AgentRunResult {
  status: 'completed' | 'awaiting_confirmation' | 'failed' | 'budget_exceeded';
  answer?: string;
  question?: string;
  observations: AgentObservation[];
  pendingWrites?: AgentToolCall[];
  steps: number;
  toolCalls: number;
  tokens: number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
}

function riskForTool(tool: AgentTool, call: AgentToolCall): AiRiskLevel {
  if (tool.riskLevel) return tool.riskLevel;
  const risk = classifyAiWriteRisk({ ...(call.input as AiWriteAction), type: call.input.type ?? tool.kind }).level;
  return tool.kind === 'write' && risk === 'L0' ? 'L2' : risk;
}

/**
 * Provider-neutral agent loop. Read calls in one round can run in parallel;
 * writes are never parallelized and are gated before execution.
 */
export async function runAiAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const controller = new AbortController();
  const signal = controller.signal;
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const gateway = options.toolGateway ?? createAgentToolGateway({
    tools: options.tools ?? [], runId: options.runId, actor: options.actor, role: options.role,
  });
  const observations: AgentObservation[] = [];
  const startedAt = Date.now();
  const allowedRisk = options.allowRisk ?? 'L1';
  let tokens = 0;
  let toolCalls = 0;
  let step = 0;
  let externalWriteAuthorized = false;
  const emit = (event: AgentRunEvent) => options.onEvent?.(event);
  const result = (value: AgentRunResult): AgentRunResult => {
    options.signal?.removeEventListener('abort', abortFromCaller);
    return value;
  };
  emit({ type: 'started', budget: options.budget });

  try {
    while (step < options.budget.maxSteps) {
      throwIfAborted(signal);
      if (Date.now() - startedAt >= options.budget.maxDurationMs || toolCalls >= options.budget.maxToolCalls || tokens >= options.budget.maxTokens) {
        emit({ type: 'budget', step, message: '已达到 Agent 预算上限', budget: options.budget });
        return result({ status: 'budget_exceeded', observations, steps: step, toolCalls, tokens });
      }
      step += 1;
      emit({ type: 'step', step, message: `第 ${step} 轮决策` });
      const decision = await options.model.decide({ step, observations: [...observations], signal });
      tokens += Number(decision.usage?.totalTokens ?? 0);
      if (tokens >= options.budget.maxTokens || Date.now() - startedAt >= options.budget.maxDurationMs) {
        emit({ type: 'budget', step, message: '模型决策已达到 Agent 预算上限', budget: options.budget });
        return result({ status: 'budget_exceeded', observations, steps: step, toolCalls, tokens });
      }
      if (decision.type === 'answer') {
        emit({ type: 'completed', step, message: '任务完成' });
        return result({ status: 'completed', answer: decision.answer ?? '', observations, steps: step, toolCalls, tokens });
      }
      if (decision.type === 'clarify') {
        emit({ type: 'awaiting-confirmation', step, message: decision.question ?? '需要补充信息' });
        return result({ status: 'awaiting_confirmation', question: decision.question, observations, steps: step, toolCalls, tokens });
      }
      const calls = decision.calls ?? [];
      if (!calls.length) throw new Error('模型返回了空的工具调用列表');
      const writeCalls = calls.filter((call) => gateway.find(call.name)?.kind === 'write');
      const highRiskWrites = writeCalls.filter((call) => {
        const tool = gateway.find(call.name);
        if (!tool) return false;
        const risk = riskForTool(tool, call);
        return risk !== 'L0' && !(risk === 'L1' && allowedRisk === 'L1');
      });
      if (highRiskWrites.length) {
        emit({ type: 'awaiting-confirmation', step, message: '写操作需要用户确认' });
        if (!options.authorizeWrites || !(await options.authorizeWrites(highRiskWrites))) {
          return result({ status: 'awaiting_confirmation', pendingWrites: highRiskWrites, observations, steps: step, toolCalls, tokens });
        }
        externalWriteAuthorized = true;
      }
      if (toolCalls + calls.length > options.budget.maxToolCalls) {
        emit({ type: 'budget', step, message: '工具调用数量已达到 Agent 预算上限', budget: options.budget });
        return result({ status: 'budget_exceeded', observations, steps: step, toolCalls, tokens });
      }
      const gatewayContext: AgentToolGatewayContext = {
        runId: options.runId ?? 'run-unknown', actor: options.actor ?? 'local-user', role: options.role ?? 'editor', signal,
        permissionScope: options.permissionScope,
        untrustedContext: options.untrustedContext === true,
        externalWriteAuthorized,
      };
      const preflight = await gateway.preflight(calls, gatewayContext);
      const denied = preflight.filter((item) => !item.allowed);
      if (denied.length) {
        const message = denied.map((item) => item.reason).filter(Boolean).join('；') || '工具权限复核未通过';
        emit({ type: 'failed', step, message });
        return result({ status: 'failed', observations, steps: step, toolCalls, tokens });
      }

      const readCalls = calls.filter((call) => !writeCalls.includes(call));
      const executeCall = async (call: AgentToolCall): Promise<AgentObservation> => {
        throwIfAborted(signal);
        const tool = gateway.find(call.name);
        if (!tool) return { call, ok: false, error: `未知工具：${call.name}` };
        toolCalls += 1;
        emit({ type: 'tool-start', step, call });
        try {
          const value = await gateway.execute(call, gatewayContext);
          const observation = { call, ok: true, result: value };
          emit({ type: 'tool-result', step, call, observation });
          return observation;
        } catch (error) {
          if (isAbortError(error)) throw error;
          const observation = { call, ok: false, error: error instanceof Error ? error.message : String(error) };
          emit({ type: 'tool-result', step, call, observation });
          return observation;
        }
      };
      const readResults = await Promise.all(readCalls.map(executeCall));
      const writeResults: AgentObservation[] = [];
      for (const call of writeCalls) writeResults.push(await executeCall(call));
      observations.push(...readResults, ...writeResults);
    }
    emit({ type: 'budget', step, message: '已达到最大决策轮数', budget: options.budget });
    return result({ status: 'budget_exceeded', observations, steps: step, toolCalls, tokens });
  } catch (error) {
    if (isAbortError(error)) return result({ status: 'failed', observations, steps: step, toolCalls, tokens });
    emit({ type: 'failed', step, message: error instanceof Error ? error.message : String(error) });
    return result({ status: 'failed', observations, steps: step, toolCalls, tokens });
  }
}

