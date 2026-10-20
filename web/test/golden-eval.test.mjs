import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateGoldenSet, scoreAnswer } from '../../src-tauri/eval/metrics-report.mjs';
import { compareGoldenReports } from '../../src-tauri/eval/golden-regression.mjs';
import { evaluateQualityGate } from '../../src-tauri/eval/quality-gate.mjs';

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
console.log('golden eval tests passed');

