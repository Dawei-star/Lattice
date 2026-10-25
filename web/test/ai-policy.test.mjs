import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAiAgentBudget, classifyAiWriteRisk, filterPermittedSources, resolveAiScope, routeAiRequest } from '../src/lib/ai-policy.ts';

test('supports multiple intents and selects a reasoning tier for tasks', () => {
  const route = routeAiRequest('搜索项目进展，再写成周报');
  assert.deepEqual(route.intents, ['writing', 'search']);
  assert.equal(route.modelTier, 'reasoning');
  assert.ok(route.confidence >= 0.8);
});

test('marks generic short requests for clarification while keeping explicit requests routable', () => {
  const unclear = routeAiRequest('帮我处理一下');
  assert.equal(unclear.requiresClarification, true);
  assert.ok(unclear.confidence < 0.55);

  const explicit = routeAiRequest('检查当前笔记的 Markdown 问题');
  assert.equal(explicit.requiresClarification, false);
  assert.deepEqual(explicit.intents, ['qa']);
});

test('resolves explicit scope first and filters unauthorized sources before context assembly', () => {
  const scope = resolveAiScope([
    { kind: 'selection', label: '当前选区', permitted: true, available: true },
    { kind: 'page', label: '当前页面', permitted: true, available: true },
  ], { kind: 'explicit', id: 'page-1', label: '@项目页面', permitted: true, available: true });
  assert.equal(scope.source, 'explicit');
  assert.deepEqual(filterPermittedSources([
    { value: 'visible', permitted: true },
    { value: 'secret', permitted: false },
  ]), ['visible']);
});

test('classifies writes by impact and reversibility', () => {
  assert.equal(classifyAiWriteRisk({ type: 'create', targetExists: false }).level, 'L1');
  assert.equal(classifyAiWriteRisk({ type: 'update', targetExists: true }).level, 'L2');
  assert.equal(classifyAiWriteRisk({ type: 'delete' }).level, 'L3');
  assert.equal(classifyAiWriteRisk({ type: 'update' }, { batchSize: 3 }).level, 'L3');
  assert.equal(classifyAiWriteRisk({ type: 'search' }).level, 'L0');
});

test('keeps task and quick budgets distinct', () => {
  assert.ok(buildAiAgentBudget('task').maxSteps > buildAiAgentBudget('quick').maxSteps);
  assert.ok(buildAiAgentBudget('task').maxDurationMs > buildAiAgentBudget('quick').maxDurationMs);
});

// ── W7a 双侧夹具：与 Rust ai::core::agent::risk 读同一份 JSON，逐字段互证 ──
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const riskFixture = JSON.parse(readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src-tauri', 'tests', 'fixtures', 'risk-classification.json'),
  'utf8',
));
test('risk classification matches the frozen shared contract', () => {
  for (const item of riskFixture.cases) {
    const assessment = classifyAiWriteRisk(item.action, { batchSize: item.batchSize });
    assert.equal(assessment.level, item.expected.level, `${item.name}: level 不一致`);
    assert.equal(assessment.reversible, item.expected.reversible, `${item.name}: reversible 不一致`);
    assert.equal(assessment.requiresConfirmation, item.expected.requiresConfirmation, `${item.name}: requiresConfirmation 不一致`);
    assert.equal(assessment.reason, item.expected.reason, `${item.name}: reason 不一致`);
  }
});

console.log('AI policy tests passed（含 W7a 双侧共享夹具）');

