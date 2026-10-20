import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAiRunStages } from '../src/lib/ai-run.ts';

const base = {
  mode: 'task',
  sending: false,
  streamText: false,
  reasoning: false,
  hasAnswer: false,
  hasReferences: false,
  hasTools: false,
  hasPreview: false,
  hasExecution: false,
  failed: false,
  contextLabel: '当前笔记',
  pageCount: 1,
  webSearch: false,
};

test('shows retrieval and generation as live stages during streaming', () => {
  const stages = buildAiRunStages({ ...base, sending: true });
  assert.equal(stages.find((stage) => stage.id === 'retrieval')?.status, 'running');
  assert.equal(stages.find((stage) => stage.id === 'synthesis')?.status, 'idle');

  const generating = buildAiRunStages({ ...base, sending: true, streamText: true });
  assert.equal(generating.find((stage) => stage.id === 'retrieval')?.status, 'idle');
  assert.equal(generating.find((stage) => stage.id === 'synthesis')?.status, 'running');
});

test('puts write actions behind review and execution gates', () => {
  const preview = buildAiRunStages({ ...base, hasPreview: true });
  assert.equal(preview.find((stage) => stage.id === 'review')?.status, 'waiting');
  assert.equal(preview.find((stage) => stage.id === 'execute')?.status, 'waiting');

  const executed = buildAiRunStages({ ...base, hasExecution: true, hasTools: true });
  assert.equal(executed.find((stage) => stage.id === 'execute')?.status, 'completed');
  assert.equal(executed.find((stage) => stage.id === 'audit')?.status, 'completed');
});

test('marks tool calls as skipped for quick read-only requests', () => {
  const stages = buildAiRunStages({ ...base, mode: 'quick', hasAnswer: true, hasReferences: true });
  assert.equal(stages.find((stage) => stage.id === 'tools')?.status, 'skipped');
  assert.equal(stages.find((stage) => stage.id === 'retrieval')?.status, 'completed');
});

console.log('AI run tests passed');
