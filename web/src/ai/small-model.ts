import { isTauri } from '@tauri-apps/api/core';
import type { AiProviderConfig, AiSettings } from '../settings/aiSettings.ts';
import { getSmallModelProviderRuntime } from '../settings/aiSettings.ts';
import type { AiIntent, AiRouteDecision, AiModelTier } from '../lib/ai-policy.ts';

export interface SmallModelCandidate {
  id: string;
  title: string;
  excerpt: string;
  score: number;
}

export interface SmallModelInvoker {
  (command: string, args: Record<string, unknown>): Promise<unknown>;
}

const ALLOWED_INTENTS = new Set<AiIntent>(['writing', 'qa', 'search', 'agent']);
const ALLOWED_TIERS = new Set<AiModelTier>(['fast', 'standard', 'reasoning']);

function responseText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const result = value as Record<string, unknown>;
  if (typeof result.text === 'string') return result.text;
  if (typeof result.content === 'string') return result.content;
  return '';
}

function parseJson(value: unknown): Record<string, unknown> | null {
  const text = responseText(value).trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseIntentDecision(value: unknown): AiRouteDecision | null {
  const parsed = parseJson(value);
  const intents = Array.isArray(parsed?.intents)
    ? [...new Set(parsed.intents.filter((item): item is AiIntent => typeof item === 'string' && ALLOWED_INTENTS.has(item as AiIntent)))].slice(0, 4)
    : [];
  const confidence = Number(parsed?.confidence);
  const tier = typeof parsed?.modelTier === 'string' && ALLOWED_TIERS.has(parsed.modelTier as AiModelTier)
    ? parsed.modelTier as AiModelTier
    : null;
  if (!intents.length || !Number.isFinite(confidence) || !tier) return null;
  return {
    intents,
    confidence: Math.min(Math.max(confidence, 0), 1),
    modelTier: tier,
    requiresClarification: parsed?.requiresClarification === true,
    reasons: ['远程轻量模型判断'],
  };
}

export function parseRerankDecision(value: unknown, candidates: readonly SmallModelCandidate[]): string[] | null {
  const parsed = parseJson(value);
  const raw = Array.isArray(parsed?.order) ? parsed.order : Array.isArray(parsed?.rankedIds) ? parsed.rankedIds : null;
  if (!raw) return null;
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  const ids = raw.filter((item): item is string => typeof item === 'string' && allowed.has(item));
  return ids.length ? [...new Set(ids)] : null;
}

function buildIntentPrompt(message: string, mode: string, hasAttachments: boolean): string {
  return [
    '只输出 JSON，不要 Markdown、解释或额外文字。',
    '将用户请求分类为一个或多个意图。intents 只能使用 writing、qa、search、agent。modelTier 只能使用 fast、standard、reasoning。',
    JSON.stringify({ task: 'intent', message: message.slice(0, 2000), mode, hasAttachments }),
    '格式：{"intents":["qa"],"confidence":0.0,"modelTier":"fast","requiresClarification":false}',
  ].join('\n');
}

function buildRerankPrompt(query: string, candidates: readonly SmallModelCandidate[]): string {
  return [
    '只输出 JSON，不要 Markdown、解释或额外文字。按与查询的相关性从高到低排序候选 id。只能使用给出的 id，可以省略不相关候选。',
    JSON.stringify({ task: 'rerank', query: query.slice(0, 500), candidates: candidates.map((candidate) => ({ ...candidate, excerpt: candidate.excerpt.slice(0, 300) })) }),
    '格式：{"order":["candidate-id"]}',
  ].join('\n');
}

export function createSmallModelClient(invoke: SmallModelInvoker) {
  const call = async (provider: AiProviderConfig, task: 'intent' | 'rerank', prompt: string): Promise<unknown> => {
    if (!isTauri()) throw new Error('small model requires desktop transport');
    return invoke('ai_small_model', { provider, task, input: prompt });
  };

  return {
    async classifyIntent(settings: AiSettings, message: string, mode: string, hasAttachments: boolean): Promise<AiRouteDecision | null> {
      const provider = getSmallModelProviderRuntime(settings);
      if (!provider) return null;
      try {
        return parseIntentDecision(await call(provider, 'intent', buildIntentPrompt(message, mode, hasAttachments)));
      } catch {
        return null;
      }
    },
    async rerank(settings: AiSettings, query: string, candidates: readonly SmallModelCandidate[]): Promise<string[] | null> {
      const provider = getSmallModelProviderRuntime(settings);
      if (!provider || !candidates.length) return null;
      try {
        return parseRerankDecision(await call(provider, 'rerank', buildRerankPrompt(query, candidates)), candidates);
      } catch {
        return null;
      }
    },
  };
}

