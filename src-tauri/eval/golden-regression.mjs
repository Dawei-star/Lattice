#!/usr/bin/env node
/**
 * Compares two local golden-set reports and fails on quality regression.
 *
 * Usage:
 *   node src-tauri/eval/golden-regression.mjs baseline.json candidate.json
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function compareGoldenReports(baseline, candidate, options = {}) {
  const maxMeanDrop = Number.isFinite(Number(options.maxMeanDrop)) ? Number(options.maxMeanDrop) : 0.05;
  const maxCategoryDrop = Number.isFinite(Number(options.maxCategoryDrop)) ? Number(options.maxCategoryDrop) : 0.10;
  const maxNewForbiddenHits = Number.isFinite(Number(options.maxNewForbiddenHits)) ? Number(options.maxNewForbiddenHits) : 0;
  const maxMissingIncrease = Number.isFinite(Number(options.maxMissingIncrease)) ? Number(options.maxMissingIncrease) : 0;
  const failures = [];
  const meanDelta = numberOrZero(candidate?.mean) - numberOrZero(baseline?.mean);
  const forbiddenHitsDelta = numberOrZero(candidate?.forbiddenHits) - numberOrZero(baseline?.forbiddenHits);
  const missingDelta = numberOrZero(candidate?.missing) - numberOrZero(baseline?.missing);

  if (candidate?.total !== baseline?.total) failures.push(`total changed: ${baseline?.total} -> ${candidate?.total}`);
  const beforeCategoryNames = [...new Set((baseline?.byCategory ?? []).map((item) => String(item.category)))].sort();
  const afterCategoryNames = [...new Set((candidate?.byCategory ?? []).map((item) => String(item.category)))].sort();
  if (JSON.stringify(beforeCategoryNames) !== JSON.stringify(afterCategoryNames)) failures.push('category set changed');
  if (meanDelta < -maxMeanDrop) failures.push(`mean dropped by ${Math.abs(meanDelta).toFixed(4)} (limit ${maxMeanDrop})`);
  if (forbiddenHitsDelta > maxNewForbiddenHits) failures.push(`forbidden hits increased by ${forbiddenHitsDelta} (limit ${maxNewForbiddenHits})`);
  if (missingDelta > maxMissingIncrease) failures.push(`missing answers increased by ${missingDelta} (limit ${maxMissingIncrease})`);

  const beforeCategories = new Map((baseline?.byCategory ?? []).map((item) => [String(item.category), item]));
  const categoryDeltas = (candidate?.byCategory ?? []).map((item) => {
    const previous = beforeCategories.get(String(item.category));
    const delta = previous && item.mean !== null && previous.mean !== null
      ? numberOrZero(item.mean) - numberOrZero(previous.mean)
      : null;
    if (delta !== null && delta < -maxCategoryDrop) failures.push(`category ${item.category} dropped by ${Math.abs(delta).toFixed(4)} (limit ${maxCategoryDrop})`);
    return { category: item.category, before: previous?.mean ?? null, after: item.mean ?? null, delta };
  });

  return {
    passed: failures.length === 0,
    thresholds: { maxMeanDrop, maxCategoryDrop, maxNewForbiddenHits, maxMissingIncrease },
    baseline: { mean: baseline?.mean ?? null, forbiddenHits: baseline?.forbiddenHits ?? null, missing: baseline?.missing ?? null },
    candidate: { mean: candidate?.mean ?? null, forbiddenHits: candidate?.forbiddenHits ?? null, missing: candidate?.missing ?? null },
    meanDelta,
    forbiddenHitsDelta,
    missingDelta,
    categoryDeltas,
    failures,
  };
}

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

if (isCli) {
  const baselinePath = process.argv[2];
  const candidatePath = process.argv[3];
  if (!baselinePath || !candidatePath) {
    console.error('用法：node src-tauri/eval/golden-regression.mjs baseline-report.json candidate-report.json');
    process.exitCode = 2;
  } else {
    const report = compareGoldenReports(loadJson(baselinePath), loadJson(candidatePath));
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}

