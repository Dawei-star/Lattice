/**
 * Golden set 基线跑分。
 *
 * 用途：性能/质量改动上线前后各跑一次，得到可对比的分数与延迟基线。
 * 跑法（在 server/ 目录下）：
 *   node --env-file-if-exists=.env eval/run-golden.mjs [--limit N] [--category xxx] [--local]
 *
 * - 未加 --local 且服务端已配置外部模型（模型管理中心 + .env 解密密钥）时走真实模型；
 *   会话不落库（不传 sessionId），但每次请求会写入 ai_chat_metrics 度量表。
 * - --local 强制本地模式（不传 preferModel / provider），得到确定性的本地基线。
 * - 报告写入 eval/reports/golden-<时间戳>.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const limit = Number(argValue('--limit')) || null;
const categoryFilter = argValue('--category');
const forceLocal = args.includes('--local');

const { config } = await import('../src/config/index.js');
const { openDatabase } = await import('../src/db/index.js');
const { runMigrations } = await import('../src/db/migrate.js');
openDatabase();
runMigrations();

const { chat } = await import('../src/modules/ai/ai.service.js');
const { summarizeMetrics } = await import('../src/modules/ai/ai.metrics.js');

const dataset = JSON.parse(fs.readFileSync(path.join(evalDir, 'golden-set.json'), 'utf8'));
let items = dataset.items;
if (categoryFilter) items = items.filter((item) => item.category === categoryFilter);
if (limit) items = items.slice(0, limit);

const metricsStartedAt = new Date().toISOString();
const results = [];

for (const item of items) {
  const startedAt = Date.now();
  let reply = '';
  let meta = null;
  let failure = null;
  try {
    const payload = await chat({
      message: item.question,
      context: { files: [], folders: [] },
      // 不传 sessionId：评估不污染用户会话历史
      ...(forceLocal ? {} : { preferModel: true }),
    });
    reply = String(payload.reply ?? '');
    meta = payload.meta ?? null;
  } catch (error) {
    failure = error?.message ?? String(error);
  }
  const totalMs = Date.now() - startedAt;

  const haystack = reply.toLowerCase();
  const missing = (item.mustInclude ?? []).filter((keyword) => !haystack.includes(String(keyword).toLowerCase()));
  const forbiddenHits = (item.forbid ?? []).filter((keyword) => haystack.includes(String(keyword).toLowerCase()));
  const score = failure ? 0 : forbiddenHits.length ? 0 : item.mustInclude?.length ? (item.mustInclude.length - missing.length) / item.mustInclude.length : 1;

  results.push({
    id: item.id,
    category: item.category,
    score: Math.round(score * 100) / 100,
    missing,
    forbiddenHits,
    failure,
    provider: meta?.provider ?? null,
    model: meta?.model ?? null,
    latencyMs: meta?.latencyMs ?? totalMs,
    totalTokens: meta?.usage?.total_tokens ?? null,
    replyPreview: reply.slice(0, 120),
  });
  process.stdout.write(`${failure ? '✗' : score >= 0.99 ? '✓' : '~'} ${item.id} score=${Math.round(score * 100)}% ${(meta?.latencyMs ?? totalMs)}ms\n`);
}

const byCategory = new Map();
for (const row of results) {
  const bucket = byCategory.get(row.category) ?? { items: 0, scoreSum: 0, latencySum: 0 };
  bucket.items += 1;
  bucket.scoreSum += row.score;
  bucket.latencySum += row.latencyMs;
  byCategory.set(row.category, bucket);
}
const summary = {
  ranAt: new Date().toISOString(),
  mode: forceLocal ? 'local' : 'prefer-model',
  items: results.length,
  averageScore: Math.round((results.reduce((sum, row) => sum + row.score, 0) / (results.length || 1)) * 100) / 100,
  averageLatencyMs: Math.round(results.reduce((sum, row) => sum + row.latencyMs, 0) / (results.length || 1)),
  totalTokens: results.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
  byCategory: [...byCategory.entries()].map(([category, bucket]) => ({
    category,
    items: bucket.items,
    averageScore: Math.round((bucket.scoreSum / bucket.items) * 100) / 100,
    averageLatencyMs: Math.round(bucket.latencySum / bucket.items),
  })),
  metrics: summarizeMetrics({ sinceIso: metricsStartedAt }),
};

console.log('\n── 汇总 ──');
console.log(`平均得分 ${summary.averageScore} · 平均延迟 ${summary.averageLatencyMs}ms · tokens ${summary.totalTokens}`);
for (const row of summary.byCategory) console.log(`  ${row.category}: score=${row.averageScore} latency=${row.averageLatencyMs}ms (n=${row.items})`);

const reportsDir = path.join(evalDir, 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const reportPath = path.join(reportsDir, `golden-${summary.ranAt.replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(reportPath, JSON.stringify({ summary, results }, null, 2));
console.log(`\n报告已写入 ${path.relative(process.cwd(), reportPath)}`);
