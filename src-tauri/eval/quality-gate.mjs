#!/usr/bin/env node
/**
 * Local quality gate for retrieval, citations, and write operations.
 * Input is an object with an `items` array. Each item may contain:
 *   relevantIds, retrievedIds, expectedCitationIds, citedCitationIds,
 *   writesAttempted, writesSucceeded.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

function ids(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item)))];
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

export function evaluateQualityGate(input, options = {}) {
  const thresholds = {
    recall: Number.isFinite(Number(options.recall)) ? Number(options.recall) : 0.80,
    citationAccuracy: Number.isFinite(Number(options.citationAccuracy)) ? Number(options.citationAccuracy) : 0.90,
    writeSuccess: Number.isFinite(Number(options.writeSuccess)) ? Number(options.writeSuccess) : 1,
  };
  const items = Array.isArray(input?.items) ? input.items : [];
  const retrievalScores = [];
  const citationCorrect = { correct: 0, total: 0 };
  let writesAttempted = 0;
  let writesSucceeded = 0;

  for (const item of items) {
    const relevant = ids(item.relevantIds);
    const retrieved = new Set(ids(item.retrievedIds));
    if (relevant.length) retrievalScores.push(relevant.filter((id) => retrieved.has(id)).length / relevant.length);

    const expectedCitations = ids(item.expectedCitationIds);
    const citedCitations = ids(item.citedCitationIds);
    if (expectedCitations.length || citedCitations.length) {
      const expected = new Set(expectedCitations);
      citationCorrect.correct += citedCitations.filter((id) => expected.has(id)).length;
      citationCorrect.total += citedCitations.length;
    }

    const attempted = Number(item.writesAttempted);
    const succeeded = Number(item.writesSucceeded);
    if (Number.isFinite(attempted) && attempted >= 0) writesAttempted += attempted;
    if (Number.isFinite(succeeded) && succeeded >= 0) writesSucceeded += Math.min(succeeded, attempted >= 0 ? attempted : succeeded);
  }

  const metrics = {
    recall: retrievalScores.length ? retrievalScores.reduce((sum, value) => sum + value, 0) / retrievalScores.length : null,
    citationAccuracy: ratio(citationCorrect.correct, citationCorrect.total),
    writeSuccess: ratio(writesSucceeded, writesAttempted),
  };
  const failures = Object.entries(thresholds)
    .filter(([name, threshold]) => metrics[name] !== null && metrics[name] < threshold)
    .map(([name, threshold]) => `${name} ${metrics[name].toFixed(4)} < ${threshold}`);
  const missing = Object.entries(thresholds)
    .filter(([name]) => metrics[name] === null)
    .map(([name]) => name);

  return {
    passed: failures.length === 0 && missing.length === 0,
    thresholds,
    metrics,
    samples: {
      items: items.length,
      retrieval: retrievalScores.length,
      citations: citationCorrect.total,
      writesAttempted,
      writesSucceeded,
    },
    failures,
    missing,
  };
}

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

if (isCli) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('用法：node src-tauri/eval/quality-gate.mjs quality-results.json');
    process.exitCode = 2;
  } else {
    const report = evaluateQualityGate(loadJson(inputPath));
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}

