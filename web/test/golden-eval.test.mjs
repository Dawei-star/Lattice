import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateGoldenSet, scoreAnswer } from '../../src-tauri/eval/metrics-report.mjs';
import { compareGoldenReports } from '../../src-tauri/eval/golden-regression.mjs';
import { evaluateQualityGate } from '../../src-tauri/eval/quality-gate.mjs';
import { buildAnchorPerfectReport, buildBaseline, goldenSetHash } from '../../src-tauri/eval/build-baseline.mjs';
import { checkBaseline, checkGoldenSet, runGate } from '../../src-tauri/eval/regression-gate.mjs';
import { isPlaceholderValue, scanText } from '../../src-tauri/eval/scan-secrets.mjs';

assert.equal(scoreAnswer({ id: 'x', mustInclude: ['链接', '卡片'], forbid: [] }, '卡片之间建立链接').score, 1);
assert.equal(scoreAnswer({ id: 'x', mustInclude: ['链接'], forbid: ['直接删除'] }, '建议直接删除').score, 0);
const golden = JSON.parse(readFileSync(resolve('../src-tauri/eval/golden-set.json'), 'utf8'));
const report = evaluateGoldenSet(golden, golden.items.map((item) => ({ id: item.id, answer: item.mustInclude.join(' ') })));
assert.equal(report.total, golden.items.length);
assert.equal(report.missing, 0);
assert.equal(report.forbiddenHits, 0);

const regression = compareGoldenReports(report, { ...report, mean: report.mean - 0.01 });
assert.equal(regression.passed, true);
assert.equal(compareGoldenReports(report, { ...report, mean: report.mean - 0.2 }).passed, false);

const quality = evaluateQualityGate({ items: [{
  relevantIds: ['note-1', 'note-2'],
  retrievedIds: ['note-2', 'note-1'],
  expectedCitationIds: ['note-1'],
  citedCitationIds: ['note-1'],
  writesAttempted: 2,
  writesSucceeded: 2,
}] });
assert.equal(quality.passed, true);
assert.equal(evaluateQualityGate({ items: [{ relevantIds: ['note-1'], retrievedIds: [], expectedCitationIds: ['note-1'], citedCitationIds: ['wrong'], writesAttempted: 1, writesSucceeded: 0 }] }).passed, false);

// --- W9：基线生成与回归门禁 ---------------------------------------------------
// 基线 = 锚点满分参照（确定性），报告均值恒为 1。
const perfect = buildAnchorPerfectReport(golden);
assert.equal(perfect.mean, 1);
assert.equal(perfect.forbiddenHits, 0);
assert.equal(perfect.missing, 0);
assert.match(goldenSetHash(golden), /^sha256:[0-9a-f]{64}$/);

const baseline = buildBaseline(golden, '2026-10-25T00:00:00.000Z');
assert.deepEqual(checkGoldenSet(golden), []);
assert.deepEqual(checkBaseline(golden, baseline), []);
assert.equal(runGate(golden, baseline).passed, true);

// 题集变更未重生成基线 → 红（哈希钉死）
assert.ok(checkBaseline(golden, { ...baseline, goldenSetHash: 'sha256:' + '0'.repeat(64) })
  .some((message) => message.includes('goldenSetHash')));
// 评分器行为漂移（复算值对不上基线报告）→ 红
const drifted = buildBaseline(golden);
drifted.report = { ...drifted.report, mean: 0.5, forbiddenHits: 2 };
assert.ok(checkBaseline(golden, drifted).length >= 2);
// mode 非锚点满分（如把真实跑分报告当基线提交）→ 红
assert.equal(checkBaseline(golden, { ...baseline, mode: 'real-run' }).length > 0, true);
// 结构坏题集 → 红：id 重复 / 锚点禁词重叠 / 双锚点全空
const broken = { version: 1, items: [
  { id: 'a', category: 'c', question: '?', mustInclude: ['x'], forbid: ['x'] },
  { id: 'a', category: 'c', question: '?', mustInclude: [], forbid: [] },
] };
assert.equal(checkGoldenSet(broken).length, 3);

// --- W9：密钥字面量扫描 -------------------------------------------------------
// 假密钥一律运行时拼接构造：测试文件自身不得出现完整凭据字面量（扫描红线同样约束本文件）。
const fakeSk = 'sk-' + 'aA1'.repeat(8);
const fakeAssign = 'Zx3-' + 'kQ9mW2vR8pL4';
const fakeBearer = 'tok' + 'A1b2C3d4E5f6G7h8I9';
assert.deepEqual(scanText(`const k = "${fakeSk}";`).map((hit) => hit.rule), ['sk-style-key']);
assert.deepEqual(scanText(`apiKey: "${fakeAssign}"`).map((hit) => hit.rule), ['credential-assignment']);
assert.equal(scanText(`Authorization: Bearer ${fakeBearer}`).length, 1);
// 占位与打码形态不算可用凭据；task- 词、redaction 正则字面量不得误伤
assert.equal(scanText('apiKey: "masked:abcd1234"').length, 0);
assert.equal(scanText('apiKey: "${process.env.LATTICE_KEY}"').length, 0);
assert.equal(scanText('apiKey: "sk-***"').length, 0);
assert.equal(scanText('include_str!("task-batch-planner/SKILL.md")').length, 0);
assert.equal(scanText('Regex::new(r"\\bsk-[A-Za-z0-9]{20,}\\b")').length, 0);
assert.equal(isPlaceholderValue('demo-key-not-a-secret-abcd'), true);
assert.equal(isPlaceholderValue('workspace-token-1234567890'), true);
assert.equal(isPlaceholderValue(fakeSk.slice(4)), false);
// 行内豁免标记
assert.equal(scanText(`apiKey: "${fakeAssign}" // lattice:allow-secret`).length, 0);

console.log('golden eval tests passed');

