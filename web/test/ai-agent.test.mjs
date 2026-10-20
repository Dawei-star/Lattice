import assert from 'node:assert/strict';
import test from 'node:test';
import { runAiAgent } from '../src/lib/ai-agent.ts';
import { createAgentToolGateway } from '../src/ai/agent-tool-gateway.ts';

const budget = { maxSteps: 4, maxToolCalls: 6, maxTokens: 1000, maxDurationMs: 5000 };

test('runs read-only tools in parallel and returns the next model answer', async () => {
  const order = [];
  let decisions = 0;
  const result = await runAiAgent({
    budget,
    tools: [
      { name: 'a', kind: 'read', execute: async () => { order.push('a'); return 1; } },
      { name: 'b', kind: 'read', execute: async () => { order.push('b'); return 2; } },
    ],
    model: { decide: async ({ observations }) => {
      decisions += 1;
      return observations.length ? { type: 'answer', answer: '完成' } : {
        type: 'tool_calls',
        calls: [{ id: 'a1', name: 'a', input: {} }, { id: 'b1', name: 'b', input: {} }],
      };
    } },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, '完成');
  assert.equal(result.toolCalls, 2);
  assert.equal(decisions, 2);
  assert.deepEqual(order.sort(), ['a', 'b']);
});

test('pauses before high-risk writes and executes only after authorization', async () => {
  let executed = false;
  const model = { decide: async () => ({ type: 'tool_calls', calls: [{ id: 'd1', name: 'delete-note', input: { type: 'delete' } }] }) };
  const paused = await runAiAgent({
    budget,
    model,
    tools: [{ name: 'delete-note', kind: 'write', execute: async () => { executed = true; return true; } }],
  });
  assert.equal(paused.status, 'awaiting_confirmation');
  assert.equal(executed, false);
  assert.equal(paused.pendingWrites?.[0].name, 'delete-note');

  const approved = await runAiAgent({
    budget,
    model: { decide: async ({ observations }) => observations.length ? { type: 'answer', answer: '已删除' } : model.decide({ step: 1, observations, signal: new AbortController().signal }) },
    tools: [{ name: 'delete-note', kind: 'write', execute: async () => { executed = true; return true; } }],
    authorizeWrites: async () => true,
  });
  assert.equal(approved.status, 'completed');
  assert.equal(executed, true);
});

test('auto-executes reversible L1 writes while keeping L2 gated', async () => {
  let executed = 0;
  const result = await runAiAgent({
    budget,
    model: { decide: async ({ observations }) => observations.length ? { type: 'answer', answer: '已创建草稿' } : { type: 'tool_calls', calls: [{ id: 'c1', name: 'create-draft', input: { type: 'create', targetExists: false } }] } },
    tools: [{ name: 'create-draft', kind: 'write', execute: async () => { executed += 1; return true; } }],
  });
  assert.equal(result.status, 'completed');
  assert.equal(executed, 1);
});

test('stops at the step budget instead of looping forever', async () => {
  const result = await runAiAgent({
    budget: { ...budget, maxSteps: 1 },
    tools: [{ name: 'read', kind: 'read', execute: async () => true }],
    model: { decide: async () => ({ type: 'tool_calls', calls: [{ id: 'r1', name: 'read', input: {} }] }) },
  });
  assert.equal(result.status, 'budget_exceeded');
  assert.equal(result.steps, 1);
});

test('routes execution through the gateway with schema, role and idempotency guards', async () => {
  let executions = 0;
  let receivedContext;
  const gateway = createAgentToolGateway({
    tools: [{
      name: 'save-draft', kind: 'write', riskLevel: 'L1', idempotent: true,
      permission: { pathFields: ['path'], requiresScope: true },
      inputSchema: { required: ['path'] },
      execute: async (_input, context) => { executions += 1; receivedContext = context; return { saved: true }; },
    }],
  });
  const call = { id: 'save-1', name: 'save-draft', input: { path: 'Drafts/a.md', type: 'create', targetExists: false } };
  const context = {
    runId: 'run-gateway', actor: 'local-user', role: 'editor', signal: new AbortController().signal,
    permissionScope: { allowedPaths: ['Drafts'] },
  };
  assert.equal((await gateway.preflight([call], context))[0].allowed, true);
  assert.deepEqual(await gateway.execute(call, context), { saved: true });
  assert.deepEqual(await gateway.execute(call, context), { saved: true });
  assert.equal(executions, 1);
  assert.equal(receivedContext.idempotencyKey, 'run-gateway:save-1:save-draft');

  const denied = await gateway.preflight([call], { ...context, role: 'viewer' });
  assert.equal(denied[0].allowed, false);
  assert.match(denied[0].reason, /viewer/);
  const invalid = await gateway.preflight([{ ...call, input: {} }], context);
  assert.equal(invalid[0].allowed, false);
  assert.match(invalid[0].reason, /缺少必填参数/);
  const outside = await gateway.preflight([{ ...call, input: { ...call.input, path: 'Private/a.md' } }], context);
  assert.equal(outside[0].allowed, false);
  assert.match(outside[0].reason, /超出授权路径范围/);
});

test('blocks untrusted high-risk writes in both preflight and execute', async () => {
  let executions = 0;
  const gateway = createAgentToolGateway({
    tools: [{
      name: 'delete-note', kind: 'write', riskLevel: 'L3', inputSchema: { required: [] },
      execute: async () => { executions += 1; return true; },
    }],
  });
  const call = { id: 'delete-1', name: 'delete-note', input: { type: 'delete' } };
  const untrusted = {
    runId: 'run-untrusted', actor: 'local-user', role: 'editor', signal: new AbortController().signal,
    untrustedContext: true,
  };
  const denied = await gateway.preflight([call], untrusted);
  assert.equal(denied[0].allowed, false);
  assert.match(denied[0].reason, /不可信内容/);
  await assert.rejects(() => gateway.execute(call, untrusted), /不可信内容/);
  assert.equal(executions, 0);

  const approved = { ...untrusted, externalWriteAuthorized: true };
  assert.equal((await gateway.preflight([call], approved))[0].allowed, true);
  assert.equal(await gateway.execute(call, approved), true);
  assert.equal(executions, 1);
});

test('retries idempotent tools, validates results, and shares concurrent calls', async () => {
  let attempts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gateway = createAgentToolGateway({
    tools: [{
      name: 'write-index', kind: 'write', riskLevel: 'L1', idempotent: true,
      retry: { maxAttempts: 3 },
      validateResult: (value) => value?.ok === true || '写入结果缺少确认标记',
      execute: async (_input, context) => {
        attempts += 1;
        if (context.attempt === 1) return { ok: false };
        await gate;
        return { ok: true, attempt: context.attempt };
      },
    }],
  });
  const call = { id: 'write-1', name: 'write-index', input: { type: 'create' } };
  const context = {
    runId: 'run-retry', actor: 'local-user', role: 'editor', signal: new AbortController().signal,
  };
  const first = gateway.execute(call, context);
  const second = gateway.execute(call, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2, '同一幂等键的并发调用应共享重试执行');
  release();
  assert.deepEqual(await first, { ok: true, attempt: 2 });
  assert.deepEqual(await second, { ok: true, attempt: 2 });
  assert.equal(attempts, 2);
  assert.deepEqual(await gateway.execute(call, context), { ok: true, attempt: 2 });
  assert.equal(attempts, 2, '完成结果应按幂等键缓存');
});

test('does not automatically retry non-idempotent tools', async () => {
  let attempts = 0;
  const gateway = createAgentToolGateway({
    tools: [{
      name: 'send-message', kind: 'write', riskLevel: 'L3',
      retry: { maxAttempts: 3 },
      execute: async () => { attempts += 1; throw new Error('network'); },
    }],
  });
  const call = { id: 'send-1', name: 'send-message', input: { type: 'send' } };
  const context = {
    runId: 'run-send', actor: 'local-user', role: 'editor', signal: new AbortController().signal,
    externalWriteAuthorized: true,
  };
  await assert.rejects(() => gateway.execute(call, context), /network/);
  assert.equal(attempts, 1);
});

console.log('AI agent tests passed');

