#!/usr/bin/env node
/**
 * 金标集回归门禁（W9 地基 ⑧，CI 红线）。
 *
 * 自检三件事（全部确定性，无需模型与密钥）：
 *   1. golden-set.json 结构健全（id 唯一、锚点/禁词合法且互斥）；
 *   2. baseline.json 的 goldenSetHash 与当前题集一致——题集变更未重生成基线即红；
 *   3. baseline.json 的报告聚合值可由题集逐字节复算——评分器行为漂移即红。
 *
 * 真实跑分的回归对比不在此脚本：用 golden-regression.mjs 对两份本地报告互比。
 *
 * 用法：node src-tauri/eval/regression-gate.mjs [repoRoot]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGoldenSet } from './metrics-report.mjs';
import { buildAnchorPerfectReport, goldenSetHash } from './build-baseline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MEAN_EPSILON = 1e-9;

/** 金标集结构校验，返回失败原因列表（空列表 = 通过）。 */
export function checkGoldenSet(golden) {
  const failures = [];
  if (!golden || typeof golden !== 'object' || !Array.isArray(golden.items)) {
    return ['golden-set.json 缺少 items 数组'];
  }
  if (!Number.isFinite(Number(golden.version)) || Number(golden.version) < 1) {
    failures.push('golden-set.json 缺少合法的 version 字段');
  }
  const seenIds = new Set();
  for (const item of golden.items) {
    const id = String(item?.id ?? '');
    if (!id) {
      failures.push('存在缺少 id 的题目');
      continue;
    }
    if (seenIds.has(id)) failures.push(`题目 id 重复：${id}`);
    seenIds.add(id);
    if (!String(item?.question ?? '').trim()) failures.push(`${id}: 缺少 question`);
    if (!String(item?.category ?? '').trim()) failures.push(`${id}: 缺少 category`);
    const mustInclude = (Array.isArray(item?.mustInclude) ? item.mustInclude : []).map(String);
    const forbid = (Array.isArray(item?.forbid) ? item.forbid : []).map(String);
    if (!mustInclude.length && !forbid.length) failures.push(`${id}: mustInclude 与 forbid 不能同时为空（至少留一个锚点，否则该题无判据）`);
    for (const phrase of [...mustInclude, ...forbid]) {
      if (!phrase.trim()) failures.push(`${id}: 锚点/禁词不能为空白串`);
    }
    const overlap = mustInclude.filter((phrase) => forbid.includes(phrase));
    if (overlap.length) failures.push(`${id}: 锚点与禁词重叠：${overlap.join(', ')}（重叠会导致满分不可能）`);
  }
  return failures;
}

/** 基线一致性校验，返回失败原因列表（空列表 = 通过）。 */
export function checkBaseline(golden, baseline) {
  const failures = [];
  if (!baseline || typeof baseline !== 'object') return ['baseline.json 缺失或不是对象'];
  if (baseline.mode !== 'anchor-perfect') {
    failures.push(`baseline.mode=${JSON.stringify(baseline.mode ?? null)}，入仓基线必须是 anchor-perfect（真实跑分报告不可复算，不能作基线）`);
  }
  const currentHash = goldenSetHash(golden);
  if (baseline.goldenSetHash !== currentHash) {
    failures.push(`goldenSetHash 不一致：题集已变更（当前 ${currentHash.slice(0, 19)}…，基线 ${String(baseline.goldenSetHash ?? 'null').slice(0, 19)}…）。请运行 npm run eval:golden:baseline 重新生成并提交`);
  }
  const expected = buildAnchorPerfectReport(golden);
  const actual = baseline.report ?? {};
  for (const field of ['total', 'answered', 'missing', 'forbiddenHits']) {
    if (actual[field] !== expected[field]) failures.push(`report.${field} 基线值 ${JSON.stringify(actual[field])} ≠ 复算值 ${expected[field]}（评分器行为与基线漂移）`);
  }
  if (!(Math.abs(Number(actual.mean ?? NaN) - expected.mean) <= MEAN_EPSILON)) {
    failures.push(`report.mean 基线值 ${JSON.stringify(actual.mean)} ≠ 复算值 ${expected.mean}`);
  }
  const expectedCategories = new Map(expected.byCategory.map((row) => [row.category, row]));
  const actualCategories = Array.isArray(actual.byCategory) ? actual.byCategory : [];
  const actualNames = [...new Set(actualCategories.map((row) => String(row.category)))].sort();
  const expectedNames = [...expectedCategories.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    failures.push(`report.byCategory 分类集合漂移：基线 [${actualNames.join(', ')}] ≠ 复算 [${expectedNames.join(', ')}]`);
  } else {
    for (const row of actualCategories) {
      const want = expectedCategories.get(String(row.category));
      if (row.answered !== want.answered) failures.push(`byCategory[${row.category}].answered 基线值 ${JSON.stringify(row.answered)} ≠ 复算值 ${want.answered}`);
      if (!(Math.abs(Number(row.mean ?? NaN) - want.mean) <= MEAN_EPSILON)) failures.push(`byCategory[${row.category}].mean 基线值 ${JSON.stringify(row.mean)} ≠ 复算值 ${want.mean}`);
    }
  }
  return failures;
}

export function runGate(golden, baseline) {
  const goldenFailures = checkGoldenSet(golden);
  const baselineFailures = baseline ? checkBaseline(golden, baseline) : ['baseline.json 缺失：先运行 npm run eval:golden:baseline 生成并提交'];
  return {
    passed: goldenFailures.length === 0 && baselineFailures.length === 0,
    goldenSet: { failures: goldenFailures },
    baseline: { failures: baselineFailures },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '..', '..');
  let golden;
  let baseline = null;
  try {
    golden = JSON.parse(readFileSync(resolve(root, 'src-tauri', 'eval', 'golden-set.json'), 'utf8'));
  } catch (error) {
    console.error(`金标集不可读：${error.message}`);
    process.exit(2);
  }
  try {
    baseline = JSON.parse(readFileSync(resolve(root, 'src-tauri', 'eval', 'baseline.json'), 'utf8'));
  } catch {
    // 缺失走 runGate 的报错分支，给出生成指引
  }
  const verdict = runGate(golden, baseline);
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.passed) process.exitCode = 1;
}
