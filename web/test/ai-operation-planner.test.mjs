import assert from 'node:assert/strict';
import { buildImpactScope, createAiOperationPlanner, isAutoExecutableL1Plan } from '../src/ai/ai-operation-planner.ts';

const calls = [];
const planner = createAiOperationPlanner({
  preview: async (input) => {
    calls.push(input);
    if (input.actions?.[0]?.type === 'archive') {
      return { operations: [{ id: 'archive-1', type: 'archive', action: input.actions[0] }], plan: { id: 'plan-1' }, planHash: 'hash-1', requiresAdditionalConfirmation: true, additionalConfirmationReasons: ['batch'] };
    }
    return { operations: [{ id: 'file-1', type: 'update', action: input.actions[0] }], quality: { blocked: false, warnings: [] } };
  },
  filePreview: async () => ({ diff: '- old\n+ new' }),
});

const result = await planner.build([
  { id: 'update-1', type: 'update', path: 'Notes/a.md', content: 'new' },
  { id: 'archive-1', type: 'archive', path: 'Inbox/b.md' },
], {}, 'editor');

assert.equal(result?.operations.length, 2);
assert.equal(result?.fileOperations[0].diff, '- old\n+ new');
assert.equal(result?.aiPlanHash, 'hash-1');
assert.equal(result?.requiresAdditionalConfirmation, true);
assert.ok(calls.some((input) => input.actions?.length === 2));

const l1Result = await createAiOperationPlanner({
  preview: async (input) => ({
    operations: [{ id: 'create-1', type: 'create', action: input.actions[0] }],
    plan: { id: 'plan-l1' },
    planHash: 'hash-l1',
  }),
  filePreview: async () => ({ diff: '' }),
}).build([{ id: 'create-1', type: 'create', path: 'Drafts/ai.md', content: '# 草稿' }], {}, 'editor');

assert.equal(l1Result?.fileOperations[0].riskLevel, 'L1');
assert.equal(l1Result?.fileOperations[0].requiresConfirmation, false);
assert.equal(isAutoExecutableL1Plan(l1Result), true);

const impact = buildImpactScope([
  {
    id: 'delete-1', orderIndex: 0, type: 'delete',
    action: { id: 'delete-1', type: 'delete', path: 'Notes/old.md' },
    impact: '移除内容；影响 1 个路径', fullPath: 'C:/Vault/Notes/old.md',
    directory: 'C:/Vault/Notes', previewFailed: false, reversible: true,
  },
  {
    id: 'send-1', orderIndex: 1, type: 'send',
    action: { id: 'send-1', type: 'send', path: 'Notes/brief.md', external: true, audience: ['团队群'] },
    previewFailed: false,
  },
]);
assert.equal(impact.operationCount, 2);
assert.equal(impact.executableCount, 2);
assert.equal(impact.resourceCount, 2);
assert.deepEqual(impact.audiences, ['团队群']);
assert.equal(impact.hasExternalEffect, true);
assert.equal(impact.hasIrreversibleEffect, true);
assert.match(impact.summary, /包含外部受众/);
console.log('AI operation planner tests passed');
