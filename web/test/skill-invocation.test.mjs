import assert from 'node:assert/strict';
import test from 'node:test';
import { addInvokedSkill, filterInvocableSkills, parseSkillSlash, removeInvokedSkill, skillDisplayName } from '../src/lib/skill-invocation.ts';

const skills = [
  { id: 'vault-search', name: 'vault-search', title: '知识库检索', description: '找证据', enabled: true },
  { id: 'note-format', name: 'note-format', title: '笔记格式', description: '整理结构', enabled: true },
  { id: 'off-skill', name: 'off-skill', title: '停用技能', description: '不应出现', enabled: false },
];

test('slash query only activates at line start', () => {
  assert.deepEqual(parseSkillSlash('/'), { active: true, query: '' });
  assert.deepEqual(parseSkillSlash('/vault'), { active: true, query: 'vault' });
  assert.deepEqual(parseSkillSlash('/vault search'), { active: false, query: '' });
  assert.deepEqual(parseSkillSlash('请用 /vault'), { active: false, query: '' });
  assert.deepEqual(parseSkillSlash('正文'), { active: false, query: '' });
});

test('filterInvocableSkills hides disabled skills and matches title/description', () => {
  assert.deepEqual(filterInvocableSkills(skills, '').map((skill) => skill.id), ['note-format', 'vault-search']);
  assert.deepEqual(filterInvocableSkills(skills, '证据').map((skill) => skill.id), ['vault-search']);
  assert.deepEqual(filterInvocableSkills(skills, 'note').map((skill) => skill.id), ['note-format']);
  assert.equal(filterInvocableSkills(skills, '停用').length, 0);
});

test('skill display name prefers the localized title', () => {
  assert.equal(skillDisplayName(skills[0]), '知识库检索');
  assert.equal(skillDisplayName({ id: 'bare' }), 'bare');
});

test('invoked skill ids are deduped and removable', () => {
  let ids = addInvokedSkill([], 'vault-search');
  ids = addInvokedSkill(ids, 'vault-search');
  ids = addInvokedSkill(ids, 'note-format');
  assert.deepEqual(ids, ['vault-search', 'note-format']);
  assert.deepEqual(removeInvokedSkill(ids, 'vault-search'), ['note-format']);
});
