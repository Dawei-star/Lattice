export type AiIntent = 'writing' | 'qa' | 'search' | 'agent';
export type AiModelTier = 'fast' | 'standard' | 'reasoning';
export type AiRiskLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type AiScopeKind = 'explicit' | 'selection' | 'page' | 'knowledge' | 'external' | 'none';

export interface AiRouteDecision {
  intents: AiIntent[];
  confidence: number;
  modelTier: AiModelTier;
  requiresClarification: boolean;
  reasons: string[];
}

export interface AiScopeCandidate {
  kind: AiScopeKind;
  id?: string;
  label: string;
  permitted: boolean;
  available: boolean;
}

export interface AiScopeDecision {
  kind: AiScopeKind;
  id?: string;
  label: string;
  source: 'explicit' | 'selection' | 'page' | 'knowledge' | 'external' | 'none';
}

export interface AiWriteAction {
  type?: unknown;
  path?: unknown;
  targetPath?: unknown;
  destination?: unknown;
  external?: unknown;
  audience?: unknown;
  targetExists?: unknown;
  aiOwnedDraft?: unknown;
  batchSize?: unknown;
}

export interface AiRiskAssessment {
  level: AiRiskLevel;
  reversible: boolean;
  requiresConfirmation: boolean;
  reason: string;
}

export interface AiAgentBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxTokens: number;
  maxDurationMs: number;
}

export interface AiPermissionedSource<T = unknown> {
  value: T;
  permitted: boolean;
}

const INTENT_PATTERNS: Array<[AiIntent, RegExp]> = [
  ['agent', /创建|新建|修改|编辑|删除|移动|复制|归档|整理|批量|执行|调用|同步|导出|发送/iu],
  ['writing', /写|撰写|改写|润色|重写|总结成|整理成|周报|提纲|翻译|摘要/iu],
  ['search', /搜索|搜一下|查找|查询|检索|最近|哪些|有没有|来源|资料/iu],
  ['qa', /为什么|怎么|如何|是什么|解释|比较|分析|回答/iu],
];

const AMBIGUOUS_REQUEST_PATTERNS = [
  /^(?:请|帮我|麻烦)?(?:看看|看一下|处理一下|弄一下|搞一下|帮忙|继续)(?:这个|它|吧|呢)?$/iu,
  /^(?:这个|它|这篇|这段)(?:呢|怎么办|怎么处理)?$/iu,
];

function isAmbiguousRequest(message: string): boolean {
  const compact = message.replace(/[\s，。！？、,.!?]+/gu, '');
  return AMBIGUOUS_REQUEST_PATTERNS.some((pattern) => pattern.test(compact));
}

/**
 * Lightweight routing only. It is deliberately deterministic so the same
 * request can be evaluated in tests and re-routed by a later model.
 */
export function routeAiRequest(input: string, options: { mode?: string; hasAttachments?: boolean } = {}): AiRouteDecision {
  const message = String(input ?? '').trim();
  const intents = INTENT_PATTERNS.filter(([, pattern]) => pattern.test(message)).map(([intent]) => intent);
  const uniqueIntents = [...new Set(intents)];
  if (!uniqueIntents.length) uniqueIntents.push(options.hasAttachments ? 'qa' : 'qa');

  const ambiguous = message.length > 0 && isAmbiguousRequest(message);
  const explicitTaskMode = options.mode === 'task';
  const confidence = message.length === 0 || ambiguous
    ? 0
    : uniqueIntents.length > 1
      ? 0.86
      : INTENT_PATTERNS.some(([intent, pattern]) => intent === uniqueIntents[0] && pattern.test(message))
        ? 0.82
        : 0.62;
  const complex = explicitTaskMode || uniqueIntents.includes('agent') || uniqueIntents.length >= 2 || message.length > 180;
  const modelTier: AiModelTier = complex ? 'reasoning' : message.length < 60 ? 'fast' : 'standard';
  const reasons = [
    uniqueIntents.length > 1 ? '请求包含多个意图' : `主要意图：${uniqueIntents[0]}`,
    complex ? '需要多步规划或工具调用' : '可优先使用单轮模型',
  ];
  return {
    intents: uniqueIntents,
    confidence,
    modelTier,
    requiresClarification: confidence < 0.55 || ambiguous,
    reasons,
  };
}

/** Explicit scope wins; otherwise use the first available and permitted scope. */
export function resolveAiScope(candidates: AiScopeCandidate[], explicit?: AiScopeCandidate | null): AiScopeDecision {
  const ordered = explicit
    ? [explicit]
    : candidates.filter((candidate) => candidate.kind !== 'explicit');
  const selected = ordered.find((candidate) => candidate.available && candidate.permitted);
  if (!selected) return { kind: 'none', label: '无可用范围', source: 'none' };
  return {
    kind: selected.kind,
    ...(selected.id ? { id: selected.id } : {}),
    label: selected.label,
    source: selected.kind,
  };
}

/**
 * Permission filtering is intentionally a separate operation from ranking.
 * Callers must filter before passing values to a model or a reranker.
 */
export function filterPermittedSources<T>(sources: AiPermissionedSource<T>[]): T[] {
  return sources.filter((source) => source.permitted).map((source) => source.value);
}

export function classifyAiWriteRisk(action: AiWriteAction, options: { batchSize?: number } = {}): AiRiskAssessment {
  const type = String(action.type ?? '').toLowerCase();
  const batchSize = Number(action.batchSize ?? options.batchSize ?? 1);
  const external = action.external === true || ['send', 'publish', 'share', 'permission', 'permissions'].includes(type);
  const destructive = ['delete', 'remove', 'purge', 'permission', 'permissions', 'send', 'publish', 'share'].includes(type);
  if (!['create', 'write', 'update', 'edit', 'move', 'copy', 'archive', 'delete', 'remove', 'purge', 'send', 'publish', 'share', 'permission', 'permissions'].includes(type)) {
    return { level: 'L0', reversible: true, requiresConfirmation: false, reason: '只读或非写操作' };
  }
  if (external || destructive || batchSize > 1) {
    return {
      level: 'L3',
      reversible: !external && !destructive,
      requiresConfirmation: true,
      reason: external ? '会影响外部系统或其他受众' : destructive ? '删除、外发或权限变更影响不可逆' : '批量操作影响范围较大',
    };
  }
  if (type === 'create' && (action.aiOwnedDraft === true || action.targetExists === false || action.targetExists === undefined)) {
    return { level: 'L1', reversible: true, requiresConfirmation: false, reason: '新建或修改 AI 自己的草稿，可通过快照撤销' };
  }
  return { level: 'L2', reversible: true, requiresConfirmation: true, reason: '会修改用户已有内容，需要预览差异' };
}

export function buildAiAgentBudget(mode: string = 'quick'): AiAgentBudget {
  return mode === 'task'
    ? { maxSteps: 12, maxToolCalls: 24, maxTokens: 16_000, maxDurationMs: 120_000 }
    : { maxSteps: 4, maxToolCalls: 6, maxTokens: 6_000, maxDurationMs: 30_000 };
}

