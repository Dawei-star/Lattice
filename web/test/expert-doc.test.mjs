import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPERT_MAX_ROUNDS,
  EXPERT_PROMPT_MAX_CHARS,
  copyDraft,
  draftFromExpert,
  emptyExpertDraft,
  expertFilePath,
  joinList,
  payloadFromDraft,
  skillDirectoryPath,
  splitList,
} from '../src/lib/expert-doc.ts';

const BUILTIN = {
  id: 'task-executor',
  version: '2.0.0',
  name: '任务执行专家',
  description: '批量执行',
  icon: 'inbox',
  enabled: true,
  systemPrompt: '你为一个多轮自主执行环境工作。',
  skills: [
    { id: 'task-batch-planner', enabled: true, mode: 'preload', priority: 60, config: {} },
    { id: 'vault-search', enabled: false, mode: 'discoverable' },
  ],
  capabilities: { context: ['current-note', 'inbox'], tools: ['read', 'search', 'write'], writePolicy: 'confirm', maxRounds: 6, scopeExclude: ['.lattice/'] },
  routing: { keywords: ['批量', '整理'], priority: 72, confidenceThreshold: 0.72 },
  source: 'builtin',
};

test('draftFromExpert 补齐默认值并淘汰退役字段', () => {
  const draft = draftFromExpert({ id: 'bare' });
  assert.equal(draft.name, 'bare', '名称缺失时回落到 id');
  assert.equal(draft.capabilities.writePolicy, 'confirm');
  assert.equal(draft.capabilities.maxRounds, 6);
  assert.deepEqual(draft.capabilities.scopeExclude, ['.lattice/', '_templates/', '.fc/']);
  assert.deepEqual(draft.capabilities.tools, ['read', 'search']);
  assert.deepEqual(draft.skills, []);
  assert.equal('scope' in draft, false, 'scope 已退役');
  assert.equal('confidenceThreshold' in draft.routing, false, 'threshold 已退役');
});

test('技能绑定归一：只留 id/enabled/mode，重复项去重', () => {
  const draft = draftFromExpert(BUILTIN);
  assert.deepEqual(draft.skills, [
    { id: 'task-batch-planner', enabled: true, mode: 'preload' },
    { id: 'vault-search', enabled: false, mode: 'discoverable' },
  ]);
  const withStrings = draftFromExpert({
    id: 'str',
    skills: ['a@preload', 'b@discoverable', 'c', 'a@preload'],
  });
  assert.deepEqual(withStrings.skills, [
    { id: 'a', enabled: true, mode: 'preload' },
    { id: 'b', enabled: true, mode: 'discoverable' },
    { id: 'c', enabled: true, mode: 'preload' },
  ]);
});

test('payloadFromDraft 输出 E1 嵌套契约，不再产生退役字段', () => {
  const payload = payloadFromDraft(draftFromExpert(BUILTIN));
  assert.equal(payload.id, 'task-executor');
  assert.equal(payload.systemPrompt, BUILTIN.systemPrompt);
  assert.deepEqual(payload.skills, [
    { id: 'task-batch-planner', enabled: true, mode: 'preload' },
    { id: 'vault-search', enabled: false, mode: 'discoverable' },
  ]);
  assert.deepEqual(payload.capabilities, {
    context: ['current-note', 'inbox'],
    tools: ['read', 'search', 'write'],
    writePolicy: 'confirm',
    maxRounds: 6,
    scopeExclude: ['.lattice/'],
  });
  assert.deepEqual(payload.routing, { keywords: ['批量', '整理'], priority: 72 });
  assert.equal('scope' in payload, false);
  assert.equal('confidenceThreshold' in payload.routing, false);
});

test('payloadFromDraft 收敛脏输入：轮数夹紧、提示词截断、路径裁剪', () => {
  const draft = emptyExpertDraft();
  draft.id = 'dirty';
  draft.name = '  脏输入  ';
  draft.systemPrompt = 'x'.repeat(EXPERT_PROMPT_MAX_CHARS + 50);
  draft.capabilities.maxRounds = 99;
  draft.routing.priority = -5;
  draft.capabilities.scopeExclude = ['  ', '.lattice/', '  '];

  const payload = payloadFromDraft(draft);
  assert.equal(payload.name, '脏输入');
  assert.equal(String(payload.systemPrompt).length, EXPERT_PROMPT_MAX_CHARS);
  assert.equal(payload.capabilities.maxRounds, EXPERT_MAX_ROUNDS);
  assert.equal(payload.routing.priority, 0, '优先级夹到 0-100');
  assert.deepEqual(payload.capabilities.scopeExclude, ['.lattice/'], '空路径被剔除');
});

test('保存载荷可以无损回读（round-trip）', () => {
  const first = payloadFromDraft(draftFromExpert(BUILTIN));
  const second = payloadFromDraft(draftFromExpert(first));
  assert.deepEqual(second, first);
});

test('copyDraft 让内置专家落到 -custom 副本，不覆盖内置 id', () => {
  const copy = copyDraft(draftFromExpert(BUILTIN));
  assert.equal(copy.id, 'task-executor-custom');
  assert.equal(copy.name, '任务执行专家 副本');
  assert.equal(copy.source, undefined, '副本是工作区条目');
  assert.notEqual(copy.skills, draftFromExpert(BUILTIN).skills, '数组不共享引用');

  const twice = copyDraft({ ...copyDraft(draftFromExpert(BUILTIN)), id: 'x-custom' });
  assert.equal(twice.id, 'x-custom-2', '已带后缀时递增而非叠加');
});

test('落盘路径统一为 .lattice 下的 Markdown / 目录', () => {
  assert.equal(expertFilePath('inbox-organizer'), '.lattice/experts/inbox-organizer.md');
  assert.equal(expertFilePath(' inbox-organizer '), '.lattice/experts/inbox-organizer.md');
  assert.equal(skillDirectoryPath('vault-search'), '.lattice/skills/vault-search/');
});

test('列表输入支持顿号/中英文逗号与换行', () => {
  assert.deepEqual(splitList('整理、归档, Inbox，批量\n收件箱'), ['整理', '归档', 'Inbox', '批量', '收件箱']);
  assert.equal(joinList(['a', 'b']), 'a、b');
  assert.equal(joinList(undefined), '');
});
