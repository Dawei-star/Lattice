import assert from 'node:assert/strict';
import { installDom } from './dom-setup.mjs';
import { classifyDurableRunRecovery, forgetDurableRun, loadDurableRunIds, rememberDurableRun, scanDurableRuns } from '../src/ai/run-recovery.ts';

installDom();
localStorage.clear();

const first = { runId: 'run-1', sessionId: 'session-1', createdAt: '2026-10-17T00:00:00.000Z' };
rememberDurableRun({ ...first, message: '不得写入本地索引', apiKey: 'secret' });
rememberDurableRun(first);
rememberDurableRun({ runId: 'run-2', sessionId: 'session-2', createdAt: '2026-10-17T00:01:00.000Z' });
assert.deepEqual(loadDurableRunIds().map((item) => item.runId), ['run-1', 'run-2']);
assert.doesNotMatch(localStorage.getItem('lattice-ai-durable-runs-v1') ?? '', /不得写入本地索引|secret/);

const runs = new Map([
  ['run-1', { status: 'failed', error: '网络失败' }],
  ['run-2', { status: 'cancelled' }],
]);
let scanned = await scanDurableRuns({ get: async (runId) => runs.get(runId) ?? null });
assert.deepEqual(scanned.map((item) => item.runId), ['run-1', 'run-2']);
assert.equal(scanned[0].recoveryKind, 'run_resume');
assert.equal(scanned[1].recoveryKind, 'run_resume');
assert.deepEqual(loadDurableRunIds().map((item) => item.runId), ['run-1', 'run-2']);

runs.set('run-1', { status: 'completed' });
scanned = await scanDurableRuns({ get: async (runId) => runs.get(runId) ?? null });
assert.deepEqual(scanned.map((item) => item.runId), ['run-2']);
assert.deepEqual(loadDurableRunIds().map((item) => item.runId), ['run-2']);

scanned = await scanDurableRuns({ get: async () => null });
assert.deepEqual(scanned, []);
assert.deepEqual(loadDurableRunIds(), []);

const isolated = { runId: 'run-confirm', sessionId: 'session-confirm', createdAt: '2026-10-17T00:03:00.000Z', expertId: 'editor', workspaceId: 'vault-a', permissionScopeId: 'scope-a', permissionVersion: 'v1' };
rememberDurableRun(isolated, 'vault-a');
assert.deepEqual(loadDurableRunIds('vault-b'), []);
const confirmationRuns = new Map([
  ['run-confirm', { status: 'completed', checkpoint: { stage: 'waiting_confirmation' } }],
]);
scanned = await scanDurableRuns({ get: async (runId) => confirmationRuns.get(runId) ?? null }, 'vault-a');
assert.deepEqual(scanned.map((item) => item.runId), ['run-confirm']);
assert.equal(scanned[0].recoveryKind, 'write_confirmation_required');
forgetDurableRun('run-confirm', 'vault-a');
assert.deepEqual(loadDurableRunIds('vault-a'), []);

rememberDurableRun({ runId: 'run-read', sessionId: 'session-read', createdAt: '2026-10-17T00:04:00.000Z' });
const readRuns = new Map([
  ['run-read', {
    status: 'completed',
    checkpoint: {
      stage: 'tool_completed',
      completedSteps: [{
        id: 'provider-read:call-1',
        toolName: 'lattice_file_read',
        callId: 'call-1',
        input: { path: 'Notes/a.md', offset: 0, limit: 100 },
        status: 'completed',
      }],
    },
  }],
]);
scanned = await scanDurableRuns({ get: async (runId) => readRuns.get(runId) ?? null });
assert.deepEqual(scanned.map((item) => item.runId), ['run-read']);
assert.equal(scanned[0].recoveryKind, 'read_replayable');
forgetDurableRun('run-read');

const writeCheckpoint = {
  stage: 'waiting_confirmation',
  completedSteps: [{ id: 'op-1', type: 'update', path: 'Notes/a.md', status: 'pending' }],
};
assert.equal(classifyDurableRunRecovery({ checkpoint: writeCheckpoint }), 'write_payload_unavailable');
assert.equal(classifyDurableRunRecovery({ checkpoint: {
  stage: 'tool_completed',
  completedSteps: [
    { id: 'provider-read:call-2', toolName: 'lattice_file_read', callId: 'call-2', input: { path: 'Notes/a.md' }, status: 'completed' },
    { id: 'op-2', toolName: 'lattice_file_operation', type: 'update', path: 'Notes/a.md', status: 'pending' },
  ],
} }), 'write_payload_unavailable');
assert.equal(classifyDurableRunRecovery({ checkpoint: {
  stage: 'tool_execution',
  completedSteps: [{ id: 'provider-tool:call-3', toolName: 'external_unknown_tool', callId: 'call-3', status: 'pending' }],
} }), 'tool_replay_unavailable');

rememberDurableRun({ runId: 'run-write', sessionId: 'session-write', createdAt: '2026-10-17T00:05:00.000Z' });
const writeRuns = new Map([
  ['run-write', { status: 'completed', checkpoint: writeCheckpoint }],
]);
scanned = await scanDurableRuns({ get: async (runId) => writeRuns.get(runId) ?? null });
assert.deepEqual(scanned.map((item) => item.runId), ['run-write']);
assert.equal(scanned[0].recoveryKind, 'write_payload_unavailable');
forgetDurableRun('run-write');

rememberDurableRun({ runId: 'run-3', sessionId: 'session-3', createdAt: '2026-10-17T00:02:00.000Z' });
forgetDurableRun('run-3');
assert.deepEqual(loadDurableRunIds(), []);
console.log('AI run recovery tests passed');
