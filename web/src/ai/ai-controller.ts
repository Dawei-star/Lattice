import { aiApi } from '../api/ai.ts';
import type { AiStreamEvent, AiStreamFinalPayload, AiStreamOptions } from '../api/ai.ts';
import type { RequestOptions } from '../api/client.ts';
import { buildAiChatRequest, type AiAttachment } from '../lib/ai-attachments.ts';
import { buildAiAgentBudget, routeAiRequest, type AiAgentBudget, type AiRouteDecision } from '../lib/ai-policy.ts';
import type { AiRequest } from './contracts.ts';
import { createRunId } from './contracts.ts';
import { createAiStreamAdapter } from './ai-stream-adapter.ts';
import { buildAiContext, type AiContextInput } from './context-builder.ts';
import { planAiQueries } from './query-planner.ts';

export interface AiControllerInput extends Omit<AiRequest, 'runId' | 'budget' | 'intents' | 'modelTier' | 'attachments'> {
  runId?: string;
  attachments?: AiAttachment[];
  preferModel?: boolean;
  /** @deprecated 语义等价于 approvalPolicy === 'skip'，保留仅供旧内核兼容。 */
  autoApprove?: boolean;
  /** 写操作审批策略：内核据此决定 L2 是否免确认（L3 永不免）。 */
  approvalPolicy?: 'always' | 'review' | 'skip';
  /**
   * 高危豁免：用户显式确认后，允许 L3（删除/外发/权限/批量）也不询问。
   * 与审批档位正交，仅在「自动执行」档下由前端置为 true。
   */
  allowIrreversible?: boolean;
  webSearch?: boolean;
  actor?: string;
  role?: string;
  expertId?: string;
  provider?: unknown;
  providerCandidates?: unknown[];
  /** Provider-neutral tool descriptors. Rust converts these to a strict provider shape. */
  tools?: unknown[];
  toolCalls?: Array<Record<string, unknown>>;
  toolResults?: Array<Record<string, unknown>>;
  mcpServers?: unknown[];
  regenerate?: boolean;
  contextBudgetTokens?: number;
  routingOverride?: AiRouteDecision;
}

export interface AiControllerPlan {
  request: Record<string, unknown>;
  routing: AiRouteDecision;
  budget: AiAgentBudget;
}

export interface AiControllerRunOptions {
  requestOptions?: RequestOptions;
  signal?: AbortSignal | null;
  onEvent?: (event: AiStreamEvent) => void;
  onRuntimeEvent?: (event: import('./contracts.ts').AiRunEvent) => void;
}

export interface AiControllerDependencies {
  streamChat?: (input: unknown, options?: AiStreamOptions) => Promise<AiStreamFinalPayload>;
}

export interface AiControllerRunResult {
  payload: AiStreamFinalPayload;
  plan: AiControllerPlan;
}

function cleanOptional<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

export function planAiRequest(input: AiControllerInput): AiControllerPlan {
  const routing = input.routingOverride ?? routeAiRequest(input.message, { mode: input.mode, hasAttachments: Boolean(input.attachments?.length) });
  const queryPlan = planAiQueries(input.message, routing.intents);
  const budget = buildAiAgentBudget(input.mode);
  const rawContext = input.context as (Record<string, unknown> & Partial<AiContextInput>) | undefined;
  const providerWindow = Number((input.provider as { contextWindowTokens?: unknown } | null | undefined)?.contextWindowTokens);
  const contextBudgetTokens = input.contextBudgetTokens
    ?? (Number.isFinite(providerWindow) && providerWindow > 0 ? Math.floor(providerWindow * 0.8) : 32_000);
  const existingPermissionContext = (rawContext?.permissionContext ?? {}) as Record<string, unknown>;
  const permissionValue = (key: string, fallback: string): string => {
    const value = existingPermissionContext[key];
    return typeof value === 'string' && value.length > 0 ? value : fallback;
  };
  const contextInput = rawContext
    ? {
      ...rawContext,
      permissionContext: {
        ...existingPermissionContext,
        actor: input.actor ?? permissionValue('actor', 'anonymous'),
        role: input.role ?? permissionValue('role', 'unknown'),
        scopeId: input.scope?.id ?? permissionValue('scopeId', input.scope?.kind ?? 'none'),
        permissionVersion: permissionValue('permissionVersion', 'unknown'),
        contentVersion: permissionValue('contentVersion', 'unknown'),
      },
    }
    : undefined;
  const context = contextInput
    ? { ...contextInput, blocks: buildAiContext(contextInput, { maxTokens: contextBudgetTokens }).blocks }
    : undefined;
  const request = buildAiChatRequest(cleanOptional({
    runId: input.runId ?? createRunId(),
    message: input.message,
    resumeRun: input.resumeRun,
    sessionId: input.sessionId,
    mode: input.mode,
    context,
    scope: input.scope,
    routing,
    queryPlan,
    budget,
    preferModel: input.preferModel,
    autoApprove: input.autoApprove,
    approvalPolicy: input.approvalPolicy,
    allowIrreversible: input.allowIrreversible,
    webSearch: input.webSearch,
    actor: input.actor,
    role: input.role,
    expertId: input.expertId,
    provider: input.provider,
    providerCandidates: input.providerCandidates,
    tools: input.tools ?? (Array.isArray((rawContext as { tools?: unknown[] } | undefined)?.tools)
      ? (rawContext as { tools: unknown[] }).tools
      : undefined),
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
    mcpServers: input.mcpServers,
    regenerate: input.regenerate,
    attachments: input.attachments,
  }));
  return { request, routing, budget };
}

/** Coordinates request preparation and transport while keeping React out of the runtime. */
export function createAiController(dependencies: AiControllerDependencies = {}) {
  const streamChat = dependencies.streamChat ?? aiApi.streamChat;
  return {
    plan(input: AiControllerInput): AiControllerPlan {
      return planAiRequest(input);
    },
    async run(input: AiControllerInput, options: AiControllerRunOptions = {}): Promise<AiControllerRunResult> {
      const plan = planAiRequest(input);
      const stream = createAiStreamAdapter(streamChat, {
        runId: String(plan.request.runId),
        onProviderEvent: options.onEvent,
        onEvent: options.onRuntimeEvent,
      });
      const payload = await stream.start(plan.request, {
        ...(options.requestOptions ?? {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { payload, plan };
    },
  };
}

