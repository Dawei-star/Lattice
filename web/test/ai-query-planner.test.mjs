import assert from 'node:assert/strict';
import { planAiQueries, rewriteQuery } from '../src/ai/query-planner.ts';

assert.equal(rewriteQuery('请帮我搜索一下  项目复盘资料。'), '项目复盘资料');

const plan = planAiQueries('搜一下项目复盘，再写成周报');
assert.deepEqual(plan.subqueries, ['项目复盘', '写成周报']);
assert.equal(plan.rewrittenQuery, '项目复盘 写成周报');
assert.equal(plan.requiresRetrieval, true);

const single = planAiQueries('请解释一下乐观锁');
assert.deepEqual(single.subqueries, ['乐观锁']);
assert.equal(single.requiresRetrieval, true);

const bounded = planAiQueries('A；B；C；D；E；F');
assert.deepEqual(bounded.subqueries, ['A', 'B', 'C', 'D']);

// 身份/能力元问题：询问对象是 AI 自身，即使撞中「是什么」等检索词也不触发检索
for (const question of ['你是什么模型', '你是谁', '你能做什么', '你会什么', '你叫什么名字', '请告诉我你是什么模型']) {
  assert.equal(planAiQueries(question).requiresRetrieval, false, `元问题不应触发检索：${question}`);
}

// 显式搜索动词优先于元问题判定：「你能帮我搜一下…」仍要检索
assert.equal(planAiQueries('你能帮我搜一下量子力学的资料吗').requiresRetrieval, true);
// 知识型「是什么」问题保持检索
assert.equal(planAiQueries('量子纠缠是什么').requiresRetrieval, true);

console.log('AI query planner tests passed');
