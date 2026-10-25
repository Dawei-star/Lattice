import assert from 'node:assert/strict';
import { buildAiTimeline, classifyToolKind } from '../src/ai/timeline.ts';

// --- 合并序夹具：progress → 未覆盖的 toolExecutions → executed/executedFailed ------
const timeline = buildAiTimeline({
  progress: [
    { id: 'client-request', label: '接收任务', status: 'completed', detail: '已发送' },
    { id: 'tool-call-1', label: '工具：lattice_note_search', status: 'completed', detail: '已完成 · 120ms' },
    { id: 'tool-call-2', label: '工具：lattice_file_read', status: 'failed', detail: '路径不存在' },
  ],
  toolExecutions: [
    { kind: 'search', label: '笔记检索', callId: 'call-1', ok: true },
    { kind: 'mcp', server: 'notion', tool: 'query', callId: 'mcp-9', ok: true, transport: 'stdio' },
    { kind: 'read', label: 'a.md', callId: 'call-2', ok: false, error: '路径不存在' },
  ],
  executed: ['创建 meeting-notes.md', '更新 index.md'],
  executedFailed: ['删除 tmp.md 失败'],
});

// progress 顺序原样保持
assert.deepEqual(timeline.slice(0, 3).map((entry) => entry.id), ['client-request', 'tool-call-1', 'tool-call-2']);
// progress 已覆盖 call-1/call-2（tool- 前缀约定）→ toolExecutions 不重复；mcp-9 未覆盖 → 追加
assert.equal(timeline.filter((entry) => entry.label.includes('笔记检索')).length, 0, '被 progress 覆盖的执行记录不重复');
const mcpEntry = timeline.find((entry) => entry.kind === 'mcp');
assert.ok(mcpEntry, '未覆盖的 MCP 执行记录追加进时间线');
assert.equal(mcpEntry.label, 'MCP notion / query');
assert.equal(mcpEntry.detail, '本地 MCP 进程');
// executed 摘要殿后，失败红
assert.deepEqual(timeline.slice(-3).map((entry) => entry.status), ['completed', 'completed', 'failed']);
assert.equal(timeline[timeline.length - 1].kind, 'execution');

// --- 图标归类 -------------------------------------------------------------------
assert.equal(classifyToolKind('lattice_note_search', undefined), 'search');
assert.equal(classifyToolKind('lattice_file_read', undefined), 'read');
assert.equal(classifyToolKind('lattice_file_operation', undefined), 'write');
assert.equal(classifyToolKind('query', 'mcp'), 'mcp');
assert.equal(classifyToolKind(undefined, 'search'), 'search');
assert.equal(classifyToolKind('lattice_unknown_tool', undefined), 'read', '未知 lattice_ 工具按读取兜底');

// --- 空输入与失败形态 -------------------------------------------------------------
assert.deepEqual(buildAiTimeline({}), []);
const failureOnly = buildAiTimeline({ toolExecutions: [{ kind: 'read', label: 'b.md', ok: false, error: '超时' }] });
assert.equal(failureOnly.length, 1);
assert.equal(failureOnly[0].status, 'failed');
assert.equal(failureOnly[0].kind, 'read');

// --- progress 步骤状态透传（pending/running/waiting 不被改写） ----------------------
const liveSteps = buildAiTimeline({
  progress: [
    { id: 's1', label: '整理 Inbox', status: 'running' },
    { id: 's2', label: '等待确认', status: 'waiting' },
  ],
});
assert.deepEqual(liveSteps.map((entry) => entry.status), ['running', 'waiting']);
assert.deepEqual(liveSteps.map((entry) => entry.kind), ['step', 'step']);

console.log('ai-timeline tests passed');
