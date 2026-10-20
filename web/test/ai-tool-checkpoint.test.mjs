import assert from 'node:assert/strict';
import { checkpointForPlan, completedToolStep, createToolCheckpoint, normalizeToolCheckpoint, recordToolCheckpointStep } from '../src/ai/tool-checkpoint.ts';

let checkpoint = createToolCheckpoint('plan-1');
checkpoint = recordToolCheckpointStep(checkpoint, { id: 'op-1', type: 'update', path: 'Notes/a.md' }, 'pending');
assert.equal(completedToolStep(checkpoint, 'op-1'), undefined);
checkpoint = recordToolCheckpointStep(checkpoint, { id: 'op-1', operationId: 'exec-1', type: 'update', path: 'Notes/a.md' }, 'completed');
assert.deepEqual(completedToolStep(checkpoint, 'op-1'), {
  id: 'op-1', operationId: 'exec-1', type: 'update', path: 'Notes/a.md', status: 'completed',
});
checkpoint = recordToolCheckpointStep(checkpoint, { id: 'op-2', type: 'delete', path: 'Notes/b.md' }, 'failed');
assert.equal(checkpoint.completedSteps.length, 2);
assert.equal(checkpointForPlan(checkpoint, 'plan-1'), checkpoint);
assert.deepEqual(checkpointForPlan(checkpoint, 'plan-2'), createToolCheckpoint('plan-2'));
assert.deepEqual(normalizeToolCheckpoint({
  stage: 'tool_failed',
  planHash: 'plan-1',
  request: { content: 'drop' },
  completedSteps: [{ id: 'op-1', status: 'completed', operationIds: ['exec-1', 2, 'exec-2'], content: 'drop', input: { path: 'Notes/a.md', query: 'find', content: 'drop', extra: 'drop' } }, { id: '', status: 'completed' }],
}), {
  stage: 'tool_failed',
  planHash: 'plan-1',
  completedSteps: [{ id: 'op-1', status: 'completed', operationIds: ['exec-1', 'exec-2'], input: { path: 'Notes/a.md', query: 'find' } }],
});
console.log('AI tool checkpoint tests passed');
