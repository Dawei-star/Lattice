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
console.log('AI query planner tests passed');
