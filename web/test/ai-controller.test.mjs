import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiController, planAiRequest } from '../src/ai/ai-controller.ts';

test('plans one request with routing and budget without depending on React state', () => {
  const plan = planAiRequest({ message: '搜索项目进展，再写成周报', mode: 'task', sessionId: 's1', context: { scope: 'project' } });
  assert.deepEqual(plan.routing.intents, ['writing', 'search']);
  assert.equal(plan.budget.maxSteps, 12);
  assert.equal(plan.request.sessionId, 's1');
  assert.equal(plan.request.routing.modelTier, 'reasoning');
  assert.equal(plan.request.attachments, undefined);
});

test('adds normalized context blocks while preserving the existing context envelope', () => {
  const plan = planAiRequest({
    message: '查找资料',
    mode: 'quick',
    context: { scope: 'project', retrieval: [{ id: 'chunk-1', content: 'external text' }] },
  });
  assert.equal(plan.request.context.scope, 'project');
  assert.equal(plan.request.context.blocks[0].id, 'chunk-1');
  assert.equal(plan.request.context.blocks[0].trusted, false);
});

test('forwards stream events and keeps the transport injectable', async () => {
  const events = [];
  let sent;
  const controller = createAiController({
    streamChat: async (request, options) => {
      sent = request;
      options?.onEvent?.({ type: 'status', text: '检索中' });
      return { text: '完成' };
    },
  });
  const runtimeEvents = [];
  const result = await controller.run({ message: '总结当前页面', mode: 'quick' }, { onEvent: (event) => events.push(event), onRuntimeEvent: (event) => runtimeEvents.push(event) });
  assert.equal(result.payload.text, '完成');
  assert.equal(sent.routing.intents[0], 'qa');
  assert.equal(events[0].text, '检索中');
  assert.equal(runtimeEvents[0].runId, sent.runId);
  assert.equal(runtimeEvents[0].type, 'status');
});

test('forwards provider-neutral tool descriptors to the desktop boundary', () => {
  const plan = planAiRequest({
    message: '读取当前笔记',
    mode: 'task',
    tools: [{
      name: 'read_note',
      kind: 'read',
      riskLevel: 'L0',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      timeoutMs: 5000,
      supportsUndo: false,
      idempotent: true,
      execute: async () => 'must not be serialized',
    }],
  });
  assert.equal(plan.request.tools[0].name, 'read_note');
  assert.equal(typeof plan.request.tools[0].execute, 'function');
});

test('builds a continuation request with tool calls and results', () => {
  const plan = planAiRequest({
    message: '请根据工具执行结果继续完成任务。',
    mode: 'task',
    toolCalls: [{ id: 'call-1', name: 'lattice_file_operation', input: { type: 'create', path: 'Notes/a.md' } }],
    toolResults: [{ callId: 'call-1', result: { status: 'completed', operationId: 'op-1' } }],
  });
  assert.equal(plan.request.toolCalls[0].id, 'call-1');
  assert.equal(plan.request.toolResults[0].result.operationId, 'op-1');
});

console.log('AI controller tests passed');

