import type { AiContextBlock, AiPermissionContext, AiToolDescriptor } from './contracts.ts';

export interface AiContextInput {
  permissionContext?: Partial<AiPermissionContext>;
  system?: string[];
  tools?: AiToolDescriptor[];
  memory?: string[];
  retrieval?: Array<{ id?: string; content: string; citationId?: string; metadata?: Record<string, unknown> }>;
  history?: string[];
  attachments?: string[];
  external?: Array<{ id?: string; content: string; provider?: string; origin?: string; metadata?: Record<string, unknown> }>;
}

export interface AiContextBuildOptions {
  /** Approximate prompt-token budget. Four UTF-16 code units are treated as one token. */
  maxTokens?: number;
}

export interface AiContextPackage {
  blocks: AiContextBlock[];
  trusted: AiContextBlock[];
  untrusted: AiContextBlock[];
  budgetTokens: number | null;
  estimatedTokens: number;
  truncated: boolean;
  compressedHistory: boolean;
  prefixCacheHit: boolean;
}

const MAX_PREFIX_CACHE_ENTRIES = 32;
const HISTORY_COMPRESSION_THRESHOLD = 12;
const MAX_PRESERVED_HISTORY_ITEMS = 8;
const CONSTRAINT_PATTERN = /必须|不要|不能|请保持|要求|约束|目标|务必|禁止|只允许|截止/iu;
const TODO_PATTERN = /(?:^-\s*\[[ xX]\]|TODO|待办|下一步|后续|计划|任务)/iu;
const prefixCache = new Map<string, AiContextBlock[]>();

function block(id: string, source: AiContextBlock['source'], content: string, trusted: boolean, extra: Partial<AiContextBlock> = {}): AiContextBlock {
  return { id, source, content, trusted, permitted: true, ...extra };
}

function normalizedPermissionContext(input: AiContextInput): AiPermissionContext {
  const permission = input.permissionContext ?? {};
  return {
    actor: String(permission.actor ?? 'anonymous'),
    role: String(permission.role ?? 'unknown'),
    scopeId: String(permission.scopeId ?? 'none'),
    permissionVersion: String(permission.permissionVersion ?? 'unknown'),
    contentVersion: String(permission.contentVersion ?? 'unknown'),
  };
}

/** Builds a stable context order and prevents retrieved data from becoming instructions. */
export function buildAiContext(input: AiContextInput = {}, options: AiContextBuildOptions = {}): AiContextPackage {
  const prefix = getOrBuildPrefix(input);
  const candidates: AiContextBlock[] = [...prefix.blocks];
  (input.retrieval ?? []).forEach((item, index) => candidates.push(block(item.id ?? `retrieval-${index + 1}`, 'retrieval', item.content, false, { citationId: item.citationId, metadata: item.metadata })));
  const history = buildHistoryCandidates(input.history ?? []);
  candidates.push(...history.blocks);
  (input.attachments ?? []).forEach((content, index) => candidates.push(block(`attachment-${index + 1}`, 'attachment', content, false)));
  (input.external ?? []).forEach((item, index) => candidates.push(block(
    item.id ?? `external-${index + 1}`,
    'external',
    item.content,
    false,
    {
      metadata: {
        ...(item.metadata ?? {}),
        ...(item.provider ? { provider: item.provider } : {}),
        ...(item.origin ? { origin: item.origin } : {}),
        untrusted: true,
      },
    },
  )));

  const numericBudget = Number(options.maxTokens);
  const budgetTokens = Number.isFinite(numericBudget) && numericBudget > 0 ? Math.floor(numericBudget) : null;
  const blocks: AiContextBlock[] = [];
  let remainingTokens = budgetTokens;
  let truncated = false;
  for (const candidate of candidates) {
    const fitted = fitBlock(candidate, remainingTokens);
    if (!fitted) {
      truncated = true;
      continue;
    }
    blocks.push(fitted);
    if (fitted.truncated) truncated = true;
    if (remainingTokens !== null) remainingTokens -= estimateTokens(fitted.content);
  }
  const estimatedTokens = blocks.reduce((total, item) => total + estimateTokens(item.content), 0);
  return {
    blocks,
    trusted: blocks.filter((item) => item.trusted),
    untrusted: blocks.filter((item) => !item.trusted),
    budgetTokens,
    estimatedTokens,
    truncated,
    compressedHistory: history.compressed,
    prefixCacheHit: prefix.cacheHit,
  };
}

export function estimateAiContextTokens(context: AiContextPackage): number {
  return context.estimatedTokens;
}

function estimateTokens(content: string): number {
  return content ? Math.ceil(content.length / 4) : 0;
}

function fitBlock(candidate: AiContextBlock, remainingTokens: number | null): AiContextBlock | null {
  if (remainingTokens === null) return candidate;
  if (remainingTokens <= 0) return null;
  const availableChars = remainingTokens * 4;
  if (candidate.content.length <= availableChars) return candidate;
  const marker = '…[已按预算截断]';
  const content = availableChars <= marker.length
    ? marker.slice(0, availableChars)
    : `${candidate.content.slice(0, availableChars - marker.length)}${marker}`;
  return { ...candidate, content, truncated: true };
}

export function clearAiContextPrefixCache(): void {
  prefixCache.clear();
}

/** Exposed for cache-boundary tests and diagnostics. */
export function buildAiContextPrefixCacheKey(input: AiContextInput): string {
  return JSON.stringify({
    permissionContext: normalizedPermissionContext(input),
    system: input.system ?? [],
    tools: input.tools ?? [],
    memory: input.memory ?? [],
  });
}

function getOrBuildPrefix(input: AiContextInput): { blocks: AiContextBlock[]; cacheHit: boolean } {
  const key = buildAiContextPrefixCacheKey(input);
  const cached = prefixCache.get(key);
  if (cached) return { blocks: cached.map(cloneBlock), cacheHit: true };
  const blocks: AiContextBlock[] = [];
  (input.system ?? []).forEach((content, index) => blocks.push(block(`system-${index + 1}`, 'system', content, true)));
  (input.tools ?? []).forEach((tool) => blocks.push(block(`tool-${tool.name}`, 'tool', JSON.stringify(tool), true, { metadata: { tool: tool.name } })));
  (input.memory ?? []).forEach((content, index) => blocks.push(block(`memory-${index + 1}`, 'memory', content, true)));
  prefixCache.set(key, blocks.map(cloneBlock));
  while (prefixCache.size > MAX_PREFIX_CACHE_ENTRIES) {
    const oldest = prefixCache.keys().next().value;
    if (oldest === undefined) break;
    prefixCache.delete(oldest);
  }
  return { blocks, cacheHit: false };
}

function buildHistoryCandidates(history: string[]): { blocks: AiContextBlock[]; compressed: boolean } {
  if (history.length <= HISTORY_COMPRESSION_THRESHOLD) {
    return {
      blocks: history.map((content, index) => block(`history-${index + 1}`, 'history', content, true)),
      compressed: false,
    };
  }
  const head = history.slice(0, 2).map((content, index) => block(`history-${index + 1}`, 'history', content, true));
  const tailStart = history.length - 4;
  const tail = history.slice(tailStart).map((content, index) => block(`history-${tailStart + index + 1}`, 'history', content, true));
  const preserved = buildPreservedHistoryBlock(history);
  const middle = history.slice(2, tailStart)
    .map((content, index) => `${index + 1}. ${compactHistoryText(content)}`)
    .join('\n');
  const summary = block('history-compressed', 'history', `[中间历史已压缩，保留 ${history.length - 6} 条摘要]\n${middle}`, true, { compressed: true });
  return { blocks: [...head, ...(preserved ? [preserved] : []), summary, ...tail], compressed: true };
}

function buildPreservedHistoryBlock(history: string[]): AiContextBlock | null {
  const constraints = collectHistoryItems(history, CONSTRAINT_PATTERN);
  const todos = collectHistoryItems(history, TODO_PATTERN);
  if (!constraints.length && !todos.length) return null;
  const sections: string[] = ['[压缩历史中保留的用户约束与待办]'];
  if (constraints.length) sections.push(`约束：\n${constraints.map((item) => `- ${item}`).join('\n')}`);
  if (todos.length) sections.push(`待办：\n${todos.map((item) => `- ${item}`).join('\n')}`);
  return block('history-preserved', 'history', sections.join('\n'), true, {
    compressed: true,
    metadata: { preserved: ['constraints', 'todos'].filter((kind) => kind === 'constraints' ? constraints.length > 0 : todos.length > 0) },
  });
}

function collectHistoryItems(history: string[], pattern: RegExp): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const content of history) {
    const lines = String(content).split(/\r?\n/).map((line) => line.replace(/^\s+|\s+$/g, '')).filter(Boolean);
    const candidates = lines.length > 1 ? lines : [String(content).replace(/\s+/g, ' ').trim()];
    for (const candidate of candidates) {
      if (!pattern.test(candidate)) continue;
      const value = compactHistoryText(candidate);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      items.push(value);
      if (items.length >= MAX_PRESERVED_HISTORY_ITEMS) return items;
    }
  }
  return items;
}

function compactHistoryText(content: string): string {
  const normalized = String(content).replace(/\s+/g, ' ').trim();
  return normalized.length > 240 ? `${normalized.slice(0, 240)}…` : normalized;
}

function cloneBlock(item: AiContextBlock): AiContextBlock {
  return { ...item, ...(item.metadata ? { metadata: { ...item.metadata } } : {}) };
}

export function serializeAiContext(context: AiContextPackage): string {
  return context.blocks.map((item) => {
    const label = item.trusted ? item.source : `untrusted_${item.source}`;
    return `<${label} id="${item.id}">\n${item.content}\n</${label}>`;
  }).join('\n\n');
}
