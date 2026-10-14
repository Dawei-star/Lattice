/**
 * 桌面通道双轨分发回归测试（升级计划 P1-05 收尾项）。
 *
 * 验证目标（不是「代码存在」，而是「分叉行为正确」）：
 *  1. 非桌面形态：绝不碰 invoke，一律走 HTTP；
 *  2. 桌面形态 + 命中映射：走 invoke，命令名与参数**逐键精确**（含 camelCase 转换、
 *     动态段 decodeURIComponent、body/query 的来源区分）；
 *  3. 路由优先级：静态路径不被动态路径吞掉（/experts/skills vs /experts/:id）；
 *  4. args 自述表达不了（缺必填参数）→ 回落 HTTP，而不是发出半成品命令；
 *  5. 未映射路由（Rust 缺命令/结构不兼容）→ 回落 HTTP；
 *  6. 信封还原：http.get 解包 .data，http.getFull 拿得到 .data；
 *  7. 命令错误是裸字符串 → 归一为 ApiError(code='IPC_ERROR')，且**不触发重试**。
 *
 * 手法：jsdom 装全局 + 覆盖 globalThis.isTauri / window.__TAURI_INTERNALS__.invoke，
 * 与 @tauri-apps/api/core 的实际实现（isTauri 读 globalThis.isTauri；invoke 调
 * window.__TAURI_INTERNALS__.invoke）保持一致。
 */
import assert from 'node:assert/strict';
import { installDom } from './dom-setup.mjs';

const dom = installDom();
const { window } = dom;

const invokeCalls = [];
let invokeImpl = async () => ({});

window.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args, options) => {
    invokeCalls.push({ cmd, args, options });
    return invokeImpl(cmd, args);
  },
};

const fetchCalls = [];
let fetchPayload = { data: { via: 'http' } };

globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(fetchPayload),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
};

globalThis.isTauri = false;
const { http, ApiError } = await import('../src/api/client.ts');

const desktop = (on) => {
  globalThis.isTauri = on;
};
const reset = () => {
  invokeCalls.length = 0;
  fetchCalls.length = 0;
  invokeImpl = async () => ({});
};
const lastInvoke = () => {
  assert.equal(invokeCalls.length, 1, `预期恰好 1 次 invoke，实际 ${invokeCalls.length}`);
  return invokeCalls[0];
};
const expectHttpOnly = (label) => {
  assert.equal(invokeCalls.length, 0, `${label}：不应触发 invoke`);
  assert.equal(fetchCalls.length, 1, `${label}：应回落到 HTTP`);
};

const checks = [];
function check(name) {
  checks.push(name);
}

// ---------------------------------------------------------------------------
// 1. 非桌面形态：一律 HTTP
desktop(false);
reset();
await http.get('/tags');
expectHttpOnly('非桌面形态');
check('非桌面形态不碰 invoke，全部走 HTTP');

// 2. 桌面形态 + 命中映射
desktop(true);
reset();
invokeImpl = async () => [{ id: 't1', name: '标签', noteCount: 1 }];
const tags = await http.get('/tags');
assert.equal(lastInvoke().cmd, 'tag_list');
assert.deepEqual(lastInvoke().args, {});
assert.deepEqual(tags, [{ id: 't1', name: '标签', noteCount: 1 }]);
assert.equal(fetchCalls.length, 0, '命中映射时不应发起 HTTP');
check('命中映射走 invoke，命令名/参数精确，且不发起 HTTP');

// 3. 路由优先级：静态段先于动态段
reset();
await http.get('/experts/skills');
assert.equal(lastInvoke().cmd, 'skill_list', '/experts/skills 不能被 /experts/:id 吞掉');
check('静态路径优先于动态路径');

// 4. 动态段解码与技能详情
reset();
await http.get(`/experts/skills/${encodeURIComponent('技能 A')}`);
assert.equal(lastInvoke().cmd, 'skill_get');
assert.deepEqual(lastInvoke().args, { id: '技能 A' });
reset();
await http.get(`/experts/${encodeURIComponent('expert-1')}`);
assert.equal(lastInvoke().cmd, 'expert_get');
assert.deepEqual(lastInvoke().args, { id: 'expert-1' });
check('动态段按 decodeURIComponent 还原后传参');

// 5. DELETE：确认参数来自 body（canvas.ts / useVault 的实际形态）
reset();
await http.delete(`/notes/${encodeURIComponent('n-1')}`, { body: { confirmed: true, secondConfirmed: true } });
assert.equal(lastInvoke().cmd, 'note_delete');
assert.deepEqual(lastInvoke().args, { id: 'n-1', confirmed: true, secondConfirmed: true });
check('DELETE 的 body 确认参数映射到命令形参');

// 6. 缺必填参数 → 回落 HTTP（不发半成品命令）
reset();
await http.get('/canvas');
expectHttpOnly('GET /canvas 缺 path');
reset();
await http.get('/canvas', { query: { path: '画板.canvas' } });
assert.equal(lastInvoke().cmd, 'canvas_read');
assert.deepEqual(lastInvoke().args, { path: '画板.canvas' });
check('args 表达不了时回落 HTTP，参数齐全时走 invoke');

// 7. 未映射路由（Rust 缺命令 / 结构不兼容）→ 回落 HTTP
//    注意：`/notes/index` 曾在列，已于 P1-08 第 2 步回收进映射表（Rust 补上 properties 对象后对齐），
//    这里改用仍然排除的路径。谁回收了一条，就从本列表删掉它。
for (const path of ['/notes/templates', '/notes/n-1', '/vault/info', '/canvas/files', '/tags/t1']) {
  reset();
  await http.get(path).catch(() => {});
  expectHttpOnly(`未映射路由 ${path}`);
}
check('缺命令/不兼容路由在桌面形态下仍走 HTTP');

// 8. 信封还原：get 解包 .data，getFull 保留 .data
reset();
invokeImpl = async () => ({ noteCount: 3, folderCount: 1 });
const overview = await http.get('/meta/overview');
assert.deepEqual(overview, { noteCount: 3, folderCount: 1 });
const full = await http.getFull('/meta/overview');
assert.deepEqual(full, { data: { noteCount: 3, folderCount: 1 } });
check('命令返回值按 {data} 信封还原，get/getFull 语义不变');

// 9. PUT /canvas：body 拆成 nodes/edges，且不多带键
reset();
await http.put('/canvas', { nodes: [], edges: [], version: 1 }, { query: { path: 'c.canvas' } });
assert.equal(lastInvoke().cmd, 'canvas_write');
assert.deepEqual(lastInvoke().args, {
  path: 'c.canvas',
  nodes: [],
  edges: [],
  expectedHash: null,
  confirmed: false,
});
check('PUT /canvas 的文档体按 nodes/edges 拆分且参数键精确');

// 10. /files/preview 的 action/actions 二态
reset();
await http.post('/files/preview', { type: 'create', path: 'a.md', content: 'x' });
assert.deepEqual(lastInvoke().args, { action: { type: 'create', path: 'a.md', content: 'x' } });
reset();
await http.post('/files/preview', { actions: [{ type: 'delete', path: 'a.md' }] });
assert.deepEqual(lastInvoke().args, { actions: [{ type: 'delete', path: 'a.md' }] });
check('file_preview 按单动作/批量二态构造形参');

// 11. cleanup 的 dryRun 必须显式回传（Rust 默认 true，前端默认 false）
reset();
await http.post('/vault/attachments/cleanup', { dryRun: false, confirmed: true, secondConfirmed: true });
assert.equal(lastInvoke().cmd, 'vault_attachment_cleanup');
assert.deepEqual(lastInvoke().args, { dryRun: false, confirmed: true, secondConfirmed: true });
check('cleanup 显式回传 dryRun，避免默认值反转');

// 12. 必填形参缺失的写操作也回落 HTTP
reset();
await http.post('/review/health/execute', { confirmed: true });
expectHttpOnly('review execute 缺 planId/planHash');
check('必填形参缺失的写操作回落 HTTP');

// 13. 命令错误是裸字符串 → ApiError(code=IPC_ERROR)，且不重试
reset();
invokeImpl = async () => {
  throw '目标笔记不存在';
};
await assert.rejects(
  () => http.get('/tags'),
  (error) => {
    assert.ok(error instanceof ApiError, '应归一为 ApiError');
    assert.equal(error.code, 'IPC_ERROR');
    assert.equal(error.message, '目标笔记不存在');
    return true;
  },
);
assert.equal(invokeCalls.length, 1, '桌面通道不应重试');
assert.equal(fetchCalls.length, 0, '命令报错后不应再回落 HTTP');
check('命令错误归一为 ApiError(code=IPC_ERROR) 且不重试');

console.log(`ipc dual-track tests passed (${checks.length} groups)`);
for (const name of checks) console.log(`  ✓ ${name}`);
