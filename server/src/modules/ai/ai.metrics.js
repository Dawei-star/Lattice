/**
 * AI 对话度量（append-only 观测投影）。
 *
 * 目标：让性能优化可验证。每次对话请求记录 TTFT（首字延迟）、总耗时、
 * token 用量、轮次与结局（done/error/cancelled），聚合出 P50/P95 与错误分布，
 * 作为 golden set 之外的第二条证据链。
 *
 * 打点失败绝不影响对话主链路：所有写入都吞异常。
 */
import { getDb } from '../../db/index.js';
import { nowIso } from '../../lib/time.js';

/**
 * 记录一次对话请求。字段缺失是常态（本地路径没有 usage/rounds），无需补齐。
 * @param {{ expertId?, sessionId?, mode?, providerKind, model?, ttftMs?, totalMs?, usage?, rounds?, outcome, errorKind? }} sample
 */
export function recordChatMetrics(sample) {
  try {
    getDb()
      .prepare(
        `INSERT INTO ai_chat_metrics
           (created_at, expert_id, session_id, mode, provider_kind, model,
            ttft_ms, total_ms, prompt_tokens, completion_tokens, total_tokens, rounds, outcome, error_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nowIso(),
        String(sample.expertId ?? 'general').slice(0, 80),
        sample.sessionId ?? null,
        String(sample.mode ?? 'assist').slice(0, 20),
        String(sample.providerKind ?? 'unknown').slice(0, 40),
        sample.model ?? null,
        Number.isFinite(sample.ttftMs) ? Math.round(sample.ttftMs) : null,
        Number.isFinite(sample.totalMs) ? Math.round(sample.totalMs) : null,
        sample.usage?.prompt_tokens ?? null,
        sample.usage?.completion_tokens ?? null,
        sample.usage?.total_tokens ?? null,
        Number.isFinite(sample.rounds) ? sample.rounds : null,
        String(sample.outcome ?? 'done'),
        sample.errorKind ? String(sample.errorKind).slice(0, 120) : null,
      );
  } catch {
    // 指标库未迁移 / 磁盘异常等情况不打断对话
  }
}

/** 百分位计算：线性插值，空数组返回 null */
function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

/**
 * 汇总最近窗口内的请求表现。
 * @param {{ sinceIso?: string }} options
 * @returns {object} 聚合报告：请求量、结局分布、TTFT/耗时 P50/P95、token 总量、按模型/专家分桶
 */
export function summarizeMetrics({ sinceIso = null } = {}) {
  const db = getDb();
  const where = sinceIso ? 'WHERE created_at >= ?' : '';
  const params = sinceIso ? [sinceIso] : [];
  const rows = db
    .prepare(`SELECT provider_kind, model, expert_id, mode, ttft_ms, total_ms, prompt_tokens, completion_tokens,
                     total_tokens, rounds, outcome, error_kind
                FROM ai_chat_metrics ${where} ORDER BY created_at ASC`)
    .all(...params);

  const external = rows.filter((row) => row.provider_kind === 'external');
  const ttftValues = external.map((row) => row.ttft_ms).filter(Number.isFinite).sort((a, b) => a - b);
  const totalValues = rows.map((row) => row.total_ms).filter(Number.isFinite).sort((a, b) => a - b);

  const outcomes = { done: 0, error: 0, cancelled: 0 };
  const errorKinds = new Map();
  for (const row of rows) {
    outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
    if (row.outcome === 'error' && row.error_kind) {
      errorKinds.set(row.error_kind, (errorKinds.get(row.error_kind) ?? 0) + 1);
    }
  }

  const byModel = new Map();
  for (const row of external) {
    const bucket = byModel.get(row.model ?? 'unknown') ?? { requests: 0, promptTokens: 0, completionTokens: 0, ttftValues: [] };
    bucket.requests += 1;
    bucket.promptTokens += row.prompt_tokens ?? 0;
    bucket.completionTokens += row.completion_tokens ?? 0;
    if (Number.isFinite(row.ttft_ms)) bucket.ttftValues.push(row.ttft_ms);
    byModel.set(row.model ?? 'unknown', bucket);
  }

  return {
    window: { since: sinceIso ?? 'all' },
    requests: rows.length,
    outcomes,
    errorKinds: [...errorKinds.entries()].map(([kind, count]) => ({ kind, count })),
    ttftMs: { p50: Math.round(percentile(ttftValues, 0.5) ?? 0) || null, p95: Math.round(percentile(ttftValues, 0.95) ?? 0) || null, samples: ttftValues.length },
    totalMs: { p50: Math.round(percentile(totalValues, 0.5) ?? 0) || null, p95: Math.round(percentile(totalValues, 0.95) ?? 0) || null, samples: totalValues.length },
    tokens: {
      prompt: rows.reduce((sum, row) => sum + (row.prompt_tokens ?? 0), 0),
      completion: rows.reduce((sum, row) => sum + (row.completion_tokens ?? 0), 0),
      total: rows.reduce((sum, row) => sum + (row.total_tokens ?? 0), 0),
    },
    roundsExhausted: rows.filter((row) => (row.rounds ?? 0) >= 6 && row.mode === 'agent').length,
    byModel: [...byModel.entries()].map(([model, bucket]) => ({
      model,
      requests: bucket.requests,
      promptTokens: bucket.promptTokens,
      completionTokens: bucket.completionTokens,
      ttftP50: Math.round(percentile([...bucket.ttftValues].sort((a, b) => a - b), 0.5) ?? 0) || null,
    })),
  };
}
