#!/usr/bin/env node
/**
 * 从 golden-set.json 重新生成确定性基线报告并写入 baseline.json（基线入仓的唯一生成入口）。
 *
 * 基线语义：CI 与本机都没有可复现的真实模型环境（密钥只走 env，不入库），
 * 因此入仓基线取「金标集自身锚点拼接成的满分答案」这一确定性参照，
 * 并以 goldenSetHash 把基线与题集钉死——题集任何改动（改锚点/增删题）都会
 * 改变哈希，regression-gate.mjs 随即变红，强制有意识地重新生成基线。
 *
 * 真实跑分的回归对比不与基线比（真实分恒低于满分锚点），而是两次本地报告互比：
 *   node src-tauri/eval/metrics-report.mjs answers-before.json > reports/before.json
 *   node src-tauri/eval/metrics-report.mjs answers-after.json  > reports/after.json
 *   node src-tauri/eval/golden-regression.mjs reports/before.json reports/after.json
 *
 * 用法：npm run eval:golden:baseline
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGoldenSet } from './metrics-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** 归一化题集条目为固定键序，作为哈希的规范形（与文件里的键序无关）。 */
export function canonicalItems(golden) {
  return (Array.isArray(golden?.items) ? golden.items : []).map((item) => ({
    id: String(item.id),
    category: String(item.category ?? ''),
    question: String(item.question ?? ''),
    mustInclude: (Array.isArray(item.mustInclude) ? item.mustInclude : []).map(String),
    forbid: (Array.isArray(item.forbid) ? item.forbid : []).map(String),
  }));
}

export function goldenSetHash(golden) {
  const digest = createHash('sha256').update(JSON.stringify(canonicalItems(golden))).digest('hex');
  return `sha256:${digest}`;
}

/** 锚点满分参照：把每题的 mustInclude 拼接为「必然得满分」的答案后复算报告。 */
export function buildAnchorPerfectReport(golden) {
  const answers = (golden.items ?? []).map((item) => ({
    id: String(item.id),
    answer: (Array.isArray(item.mustInclude) ? item.mustInclude : []).map(String).join(' '),
  }));
  return evaluateGoldenSet(golden, answers);
}

export function buildBaseline(golden, generatedAt = new Date().toISOString()) {
  return {
    version: 1,
    mode: 'anchor-perfect',
    description: '确定性锚点满分参照，由 build-baseline.mjs 从 golden-set.json 复算生成；真实跑分对比请用 eval:golden:compare 对两份本地报告，勿与基线比。',
    goldenSetHash: goldenSetHash(golden),
    generatedAt,
    report: buildAnchorPerfectReport(golden),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const goldenPath = resolve(here, 'golden-set.json');
  const baselinePath = resolve(here, 'baseline.json');
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  const baseline = buildBaseline(golden);
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  const { report } = baseline;
  console.log(JSON.stringify({
    written: baselinePath,
    goldenSetHash: baseline.goldenSetHash,
    total: report.total,
    mean: report.mean,
    forbiddenHits: report.forbiddenHits,
    missing: report.missing,
  }, null, 2));
}
