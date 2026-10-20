import assert from 'node:assert/strict';
import { notifyAiRunCompletion } from '../src/lib/ai-notifications.ts';

const calls = [];
const toast = {
  success: (message, options) => calls.push({ tone: 'success', message, options }),
  error: (message, options) => calls.push({ tone: 'error', message, options }),
};
const system = [];
const notifiedRunIds = new Set();

assert.equal(notifyAiRunCompletion({
  runId: 'run-1',
  status: 'completed',
  panelVisible: false,
  toast,
  notifiedRunIds,
  systemNotify: (title, options) => system.push({ title, options }),
}), true);
assert.deepEqual(calls[0], {
  tone: 'success',
  message: 'AI 任务已完成',
  options: {
    detail: '后台运行已完成，可返回 AI 面板查看结果。',
    dedupeKey: 'ai-run:run-1:completed',
  },
});
assert.equal(system[0].options.tag, 'ai-run:run-1:completed');
assert.equal(notifyAiRunCompletion({
  runId: 'run-1',
  status: 'completed',
  panelVisible: false,
  toast,
  notifiedRunIds,
  systemNotify: () => { throw new Error('must be deduped'); },
}), false);

assert.equal(notifyAiRunCompletion({
  runId: 'run-2',
  status: 'failed',
  panelVisible: false,
  error: '模型不可用',
  toast,
  notifiedRunIds,
  systemNotify: (title, options) => system.push({ title, options }),
}), true);
assert.equal(calls[1].tone, 'error');
assert.equal(calls[1].options.detail, '模型不可用');

assert.equal(notifyAiRunCompletion({
  runId: 'run-3',
  status: 'completed',
  panelVisible: true,
  toast,
  notifiedRunIds,
  systemNotify: () => { throw new Error('visible panel must stay quiet'); },
}), false);
assert.equal(calls.length, 2);

console.log('AI notification tests passed');
