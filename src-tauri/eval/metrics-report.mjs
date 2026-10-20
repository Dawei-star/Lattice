#!/usr/bin/env node
/**
 * Golden set evaluator for local, provider-neutral AI regression checks.
 *
 * Usage:
 *   node src-tauri/eval/metrics-report.mjs answers.json [golden-set.json]
 *
 * answers.json is an array of { id, answer } objects. The evaluator is
 * intentionally conservative: mustInclude contributes partial credit and any
 * forbidden phrase makes the item score zero. It never sends prompts or
 * answers over the network.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const goldenPath = resolve(process.argv[3] || fileURLToPath(new URL('./golden-set.json', import.meta.url)));
const answersPath = process.argv[2];
const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function scoreAnswer(item, answer) {
  const text = String(answer ?? '');
  const required = Array.isArray(item.mustInclude) ? item.mustInclude : [];
  const forbidden = Array.isArray(item.forbid) ? item.forbid : [];
  const hitCount = required.filter((phrase) => text.includes(String(phrase))).length;
  const forbiddenHit = forbidden.find((phrase) => text.includes(String(phrase)));
  return {
    id: item.id,
    category: item.category || 'uncategorized',
    score: forbiddenHit ? 0 : required.length ? hitCount / required.length : 1,
    required: required.length,
    hitCount,
    forbiddenHit: forbiddenHit || null,
  };
}

export function evaluateGoldenSet(golden, answers) {
  const byId = new Map((Array.isArray(answers) ? answers : []).map((item) => [String(item?.id), item?.answer]));
  const items = (golden.items || []).map((item) => scoreAnswer(item, byId.get(String(item.id))));
  const answered = items.filter((item) => byId.has(String(item.id)));
  const mean = answered.length ? answered.reduce((sum, item) => sum + item.score, 0) / answered.length : 0;
  const byCategory = [...new Set(items.map((item) => item.category))].map((category) => {
    const rows = answered.filter((item) => item.category === category);
    return { category, answered: rows.length, mean: rows.length ? rows.reduce((sum, item) => sum + item.score, 0) / rows.length : null };
  });
  return {
    total: items.length,
    answered: answered.length,
    missing: items.length - answered.length,
    mean,
    forbiddenHits: answered.filter((item) => item.forbiddenHit).length,
    byCategory,
    items,
  };
}

if (isCli && answersPath) {
  const report = evaluateGoldenSet(loadJson(goldenPath), loadJson(resolve(answersPath)));
  console.log(JSON.stringify(report, null, 2));
} else if (isCli) {
  console.error('用法：node src-tauri/eval/metrics-report.mjs answers.json [golden-set.json]');
  process.exitCode = 2;
}
