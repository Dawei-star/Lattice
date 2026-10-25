// AI 输出层纯函数：成本估算、本机端点判定、回答→笔记草稿转换。
// 供 AiMessageList 渲染与 AIAssistantPanel done 路径共用；无 React 依赖，可单测。

/** OpenAI 兼容 usage 载荷（桌面端原样透传，字段为 snake_case）。 */
export interface AiTokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 与 AiProviderConfig 中的价格字段同构。 */
export interface AiModelPricing {
  promptCostPer1kUsd?: number;
  completionCostPer1kUsd?: number;
}

/** loopback 端点判定（本机推理：Ollama/LM Studio/llama.cpp 等）。 */
export function isLoopbackEndpoint(endpoint: string | null | undefined): boolean {
  try {
    const url = new URL(String(endpoint));
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return ['127.0.0.1', '::1', 'localhost'].includes(host);
  } catch {
    return false;
  }
}

function finiteNonNegative(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

/**
 * 按 1k token 单价估算一次回答成本（美元）。
 * 任一价格未配置或无用量 → null（界面只显示 token，不显示金额）。
 */
export function estimateCostUsd(
  usage: Partial<AiTokenUsage> | null | undefined,
  pricing: Partial<AiModelPricing> | null | undefined,
): number | null {
  const promptCost = finiteNonNegative(pricing?.promptCostPer1kUsd);
  const completionCost = finiteNonNegative(pricing?.completionCostPer1kUsd);
  const promptTokens = finiteNonNegative(usage?.prompt_tokens);
  const completionTokens = finiteNonNegative(usage?.completion_tokens);
  if (promptCost === null || completionCost === null) return null;
  if (promptTokens === null && completionTokens === null) return null;
  const cost =
    ((promptTokens ?? 0) / 1000) * promptCost + ((completionTokens ?? 0) / 1000) * completionCost;
  return Math.round(cost * 1e6) / 1e6;
}

/** 成本标签：小额保留 4 位小数，避免 ≈$0.0000。 */
export function formatCostLabel(costUsd: number): string {
  const value = Number(costUsd);
  if (!Number.isFinite(value) || value < 0) return '$0';
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

/** 引用条目（与 AiMessageReference 同构，取渲染需要的字段）。 */
export interface AnswerReferenceLike {
  number?: number;
  title?: string;
  anchor?: string;
}

/** 消息内容（取标题与引用需要的最小形状）。 */
export interface AnswerLike {
  content: string;
  references?: AnswerReferenceLike[];
}

function noteTitleFromContent(content: string): string {
  for (const line of content.split('\n')) {
    const text = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/[*_`>~-]/g, '')
      .trim();
    if (text) return text.slice(0, 40);
  }
  return 'AI 回答笔记';
}

/**
 * 回答 → 笔记草稿：正文原样保留，引用按标题去重后转为 [[双链]] 来源清单。
 * 标题取首个非空行（剥掉 Markdown 记号），无引用时不追加来源节。
 */
export function buildAnswerNoteDraft(message: AnswerLike): { title: string; content: string } {
  const content = String(message.content ?? '').trim();
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const reference of message.references ?? []) {
    const title = String(reference?.title ?? '').trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const anchor = String(reference?.anchor ?? '').trim();
    sources.push(`- [[${title}${anchor ? `#${anchor}` : ''}]]`);
  }
  const sourceSection = sources.length ? `\n\n## 来源\n\n${sources.join('\n')}\n` : '';
  return { title: noteTitleFromContent(content), content: `${content}${sourceSection}` };
}

/**
 * 预览 diff 的 ±行数统计（U2 FileChangesCard）：unified-diff 形态——
 * `+`/`-` 前缀行计数（跳过 `+++`/`---` 文件头），其余行不计。
 */
export function countDiffLines(diff: string | null | undefined): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}
