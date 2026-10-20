import type { AiIntent } from '../lib/ai-policy.ts';

export interface AiQueryPlan {
  originalQuery: string;
  rewrittenQuery: string;
  subqueries: string[];
  requiresRetrieval: boolean;
}

const RETRIEVAL_TERMS = /搜索|搜一下|查找|查询|检索|资料|来源|哪些|有没有|为什么|怎么|如何|是什么|解释|比较|分析|总结|整理成|周报|提纲/iu;
const SPLIT_PATTERN = /\s*(?:;|；)\s*|\s*(?:并且|以及|同时|然后|另外|接着|再查|还要)\s*|\s*[，,]\s*(?=(?:再|并|同时|然后|另外|接着|写成|总结|比较|查|搜))/u;
const LEADING_REQUEST = /^(?:请|请帮我|帮我|麻烦|能否|可以|帮忙)?\s*(?:搜一下|搜索一下|搜索|查一下|查找|检索|查询一下|查询|了解|告诉我|回答|解释一下|分析一下)\s*/iu;
const LEADING_CONNECTOR = /^(?:再|并且|以及|同时|然后|另外|接着)\s*/iu;

/**
 * Produces a deterministic retrieval plan before a provider is called.
 * A later small model can replace this plan, but this baseline remains local,
 * bounded, and safe to use when no model is available.
 */
export function planAiQueries(message: string, intents: readonly AiIntent[] = []): AiQueryPlan {
  const originalQuery = String(message ?? '').replace(/\s+/g, ' ').trim();
  const segments = originalQuery
    .split(SPLIT_PATTERN)
    .map((segment) => rewriteQuery(segment))
    .filter(Boolean);
  const subqueries = [...new Set(segments)].slice(0, 4);
  const rewrittenQuery = subqueries.join(' ').trim() || rewriteQuery(originalQuery);
  const requiresRetrieval = intents.some((intent) => ['search', 'qa', 'writing'].includes(intent))
    || RETRIEVAL_TERMS.test(originalQuery)
    || subqueries.length > 1;

  return {
    originalQuery,
    rewrittenQuery: rewrittenQuery.slice(0, 200),
    subqueries: subqueries.map((query) => query.slice(0, 200)),
    requiresRetrieval,
  };
}

export function rewriteQuery(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_REQUEST, '')
    .replace(LEADING_CONNECTOR, '')
    .replace(/[。！？!?]+$/u, '')
    .trim();
}
