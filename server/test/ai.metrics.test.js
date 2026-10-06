import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-metrics-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';

const { openDatabase } = await import('../src/db/index.js');
const { runMigrations } = await import('../src/db/migrate.js');
openDatabase();
runMigrations();

const { recordChatMetrics, summarizeMetrics } = await import('../src/modules/ai/ai.metrics.js');

test('chat metrics records samples and aggregates percentiles/outcomes/tokens', () => {
  recordChatMetrics({
    expertId: 'general', mode: 'assist', providerKind: 'external', model: 'model-a',
    ttftMs: 100, totalMs: 500, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    rounds: 1, outcome: 'done',
  });
  recordChatMetrics({
    expertId: 'general', mode: 'agent', providerKind: 'external', model: 'model-a',
    ttftMs: 300, totalMs: 1500, usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
    rounds: 6, outcome: 'done',
  });
  recordChatMetrics({
    providerKind: 'external', model: 'model-b', ttftMs: 200, totalMs: 900,
    outcome: 'error', errorKind: 'AI_UPSTREAM_TIMEOUT',
  });
  recordChatMetrics({ providerKind: 'local-instant', outcome: 'done' });

  const summary = summarizeMetrics({});
  assert.equal(summary.requests, 4);
  assert.deepEqual(summary.outcomes, { done: 3, error: 1, cancelled: 0 });
  assert.deepEqual(summary.errorKinds, [{ kind: 'AI_UPSTREAM_TIMEOUT', count: 1 }]);
  // TTFT 只统计 external：100/200/300 → P50=200
  assert.equal(summary.ttftMs.p50, 200);
  assert.equal(summary.ttftMs.samples, 3);
  // 外部请求的 rounds=6 且 mode=agent → 轮次耗尽计数
  assert.equal(summary.roundsExhausted, 1);
  assert.equal(summary.tokens.total, 450);
  const modelA = summary.byModel.find((row) => row.model === 'model-a');
  assert.equal(modelA.requests, 2);
  assert.equal(modelA.promptTokens, 300);
});

test('recordChatMetrics swallows failures instead of breaking the chat path', () => {
  // 非法样本（outcome 违反 CHECK 约束）不应抛出
  assert.doesNotThrow(() => recordChatMetrics({ providerKind: 'external', outcome: 'nonsense' }));
});
