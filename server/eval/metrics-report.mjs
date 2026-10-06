/**
 * AI 对话指标速览。
 *
 * 跑法（在 server/ 目录下）：
 *   node --disable-warning=ExperimentalWarning eval/metrics-report.mjs [小时数]
 *
 * 默认看最近 24 小时：请求量、结局分布、TTFT/耗时 P50/P95、token 用量、模型分桶。
 */
import { openDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { summarizeMetrics } from '../src/modules/ai/ai.metrics.js';

const hours = Number(process.argv[2]) || 24;
openDatabase();
runMigrations();

const sinceIso = new Date(Date.now() - hours * 3_600_000).toISOString();
const s = summarizeMetrics({ sinceIso });

console.log(`── AI 对话指标（最近 ${hours} 小时） ──`);
console.log(`请求 ${s.requests} · done ${s.outcomes.done} / error ${s.outcomes.error} / cancelled ${s.outcomes.cancelled}`);
if (s.errorKinds.length) console.log(`错误分布: ${s.errorKinds.map((row) => `${row.kind}×${row.count}`).join(', ')}`);
console.log(`总耗时 P50 ${s.totalMs.p50 ?? '—'}ms · P95 ${s.totalMs.p95 ?? '—'}ms（样本 ${s.totalMs.samples}）`);
if (s.ttftMs.samples) console.log(`首字延迟 P50 ${s.ttftMs.p50}ms · P95 ${s.ttftMs.p95}ms（样本 ${s.ttftMs.samples}）`);
console.log(`tokens: prompt ${s.tokens.prompt} · completion ${s.tokens.completion} · total ${s.tokens.total}`);
console.log(`任务轮次耗尽 ${s.roundsExhausted} 次`);
for (const row of s.byModel) console.log(`  ${row.model}: ${row.requests} 次 · prompt ${row.promptTokens} · completion ${row.completionTokens}`);
