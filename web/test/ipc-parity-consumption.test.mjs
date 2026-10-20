/**
 * P1-08 第 3 步：前端消费层在两条通道下的行为一致性。
 *
 * 与前两步的分工：
 *  - 第 1 步录下 Express 的**真实**请求/响应（`src-tauri/tests/fixtures`）
 *  - 第 2 步断言 Rust 服务层的**输出结构**与 Express 的差距（`divergence.json`）
 *  - 本步不问「Rust 返回什么」，只问：**同一份 payload 交给 api 层，两条通道交付给 UI 的值是否逐字节相同**，
 *    即验证双轨封装（信封还原、错误归一、参数传递）没有在消费层引入偏差。
 *
 * 数据驱动：直接拿 50 个 fixture 当输入，同一份 `data` 分别经
 * ①HTTP（fetch 桩返回 `{data}` 信封）与 ②IPC（invoke 桩直接返回数据本身）走一遍 `http.*`，
 * 断言两条通道返回值深度相等；并断言「实际走的通道」与映射表一致——
 * 表内的请求不许悄悄回落 fetch，表外在桌面端必须明确报告未接入；HTTP
 * 语义只在非桌面通道单独作为历史契约输入保留。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom-setup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.resolve(here, '..', '..', 'src-tauri', 'tests', 'fixtures', 'cases');

installDom();
const { window } = globalThis;

const invokeCalls = [];
let invokeHandler = async () => null;
window.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args, options) => {
    invokeCalls.push({ cmd, args, options });
    return invokeHandler(cmd, args);
  },
};

const fetchCalls = [];
let fetchStub = () => ({ ok: true, status: 200, body: { data: null } });
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  const stub = fetchStub();
  return {
    ok: stub.ok,
    status: stub.status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(stub.body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
};

globalThis.isTauri = false;
const { http, ApiError } = await import('../src/api/client.ts');
const { matchIpcRoute } = await import('../src/api/ipc.ts');

/** 深拷贝：避免两条通道共享同一对象引用而让比较变成恒真 */
const COPY = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const cases = readdirSync(casesDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(path.join(casesDir, name), 'utf8')));
assert.ok(cases.length >= 40, `只读到 ${cases.length} 个 fixture，疑似路径失效`);

/** fixture 记的是 Express 完整路由（含 /api 前缀），api 层用去掉前缀的路径 */
const toApiPath = (httpPath) => httpPath.replace(/^\/api(?=\/)/, '');

function callApi(method, apiPath, { query, body }) {
  if (method === 'GET') return http.get(apiPath, { query });
  if (method === 'POST' && apiPath === '/vault/attachments') {
    return http.postRaw(
      apiPath,
      new Blob(['attachment fixture\n'], { type: 'text/plain' }),
      { query },
    );
  }
  if (method === 'POST') return http.post(apiPath, body, { query });
  if (method === 'PUT') return http.put(apiPath, body, { query });
  if (method === 'PATCH') return http.patch(apiPath, body, { query });
  if (method === 'DELETE') return http.delete(apiPath, { query, body });
  throw new Error(`未覆盖的方法：${method}`);
}

const stats = { total: cases.length, mapped: 0, unmapped: 0, fellBack: [], mismatch: [], unmappedNames: [] };

for (const entry of cases) {
  const { method, path: httpPath, query = {}, body = null, status } = entry.http;
  const apiPath = toApiPath(httpPath);
  const mapped = matchIpcRoute(method, apiPath) !== null;
  if (mapped) stats.mapped += 1;
  else {
    stats.unmapped += 1;
    stats.unmappedNames.push(entry.command);
  }

  // ① HTTP 通道：fetch 返回 Express 录下的 data（包在 {data} 信封里）
  globalThis.isTauri = false;
  invokeCalls.length = 0;
  fetchCalls.length = 0;
  fetchStub = () => ({ ok: status < 400, status, body: { data: COPY(entry.data) } });
  const viaHttp = await callApi(method, apiPath, { query, body });
  assert.equal(invokeCalls.length, 0, `${entry.command}：非桌面形态不应触发 invoke`);

  // ② IPC 通道：invoke 直接返回命令返回值（Rust 命令返回的是数据本身，无信封）
  globalThis.isTauri = true;
  invokeCalls.length = 0;
  fetchCalls.length = 0;
  invokeHandler = async () => entry.command === 'search_query'
    ? { items: COPY(entry.data), strategy: 'fts' }
    : COPY(entry.data);
  if (!mapped) {
    await assert.rejects(
      () => callApi(method, apiPath, { query, body }),
      (error) => error?.code === 'IPC_UNAVAILABLE',
      `${entry.command}：桌面端未映射请求应明确报告 IPC_UNAVAILABLE`,
    );
    assert.equal(invokeCalls.length, 0, `${entry.command}：未映射不应触发 invoke`);
    assert.equal(fetchCalls.length, 0, `${entry.command}：桌面端不应回落 HTTP`);
    continue;
  }
  const viaIpc = await callApi(method, apiPath, { query, body });

  if (mapped) {
    if (invokeCalls.length === 0) {
      // 登记在表内却回落了：桌面态没有 Express 兜底，等价于该功能在桌面不可用
      stats.fellBack.push(`${method} ${apiPath}（${entry.command}）`);
    } else {
      assert.equal(fetchCalls.length, 0, `${entry.command}：命中映射表不应回落 HTTP`);
    }
  }
  // ③ 消费层拿到的值必须一致
  if (JSON.stringify(viaHttp) !== JSON.stringify(viaIpc)) {
    stats.mismatch.push(entry.command);
  }
}

assert.deepEqual(
  stats.fellBack,
  [],
  `以下路由在映射表内、却用真实录制的请求回落到 HTTP（桌面态将无人兜底）：\n  - ${stats.fellBack.join('\n  - ')}`,
);
assert.deepEqual(
  stats.mismatch,
  [],
  `以下命令两条通道交付给消费层的值不一致：${stats.mismatch.join(', ')}`,
);

// ── 错误路径等价性：同一句用户可见文案，两条通道都要原样透出 ────────────────
const MESSAGE = '附件路径必须位于 attachments 目录';

globalThis.isTauri = false;
fetchCalls.length = 0;
fetchStub = () => ({ ok: false, status: 400, body: { error: { code: 'VALIDATION_ERROR', message: MESSAGE } } });
const httpError = await http.get('/tags').then(() => null, (error) => error);

globalThis.isTauri = true;
invokeCalls.length = 0;
invokeHandler = async () => {
  throw MESSAGE;
};
const ipcError = await http.get('/tags').then(() => null, (error) => error);

assert.equal(invokeCalls.length, 1, '错误路径也应走 invoke（桌面态）');
assert.ok(httpError instanceof ApiError, 'HTTP 轨的错误应归一为 ApiError');
assert.ok(ipcError instanceof ApiError, 'IPC 轨的错误应归一为 ApiError');
assert.equal(httpError.message, MESSAGE, 'HTTP 轨应原样透出服务端文案');
assert.equal(ipcError.message, MESSAGE, 'IPC 轨应原样透出命令错误文案');
// 已知差异（记录在案，不是本步要修的）：HTTP 轨保留服务端 code；IPC 轨命令错误是裸字符串，只能标 IPC_ERROR
assert.equal(httpError.code, 'VALIDATION_ERROR');
assert.equal(ipcError.code, 'IPC_ERROR');

console.log('ipc parity (consumption) tests passed');
console.log(`  ${stats.total} 个 fixture：映射表内 ${stats.mapped} 条走 invoke，表外 ${stats.unmapped} 条在桌面端明确拒绝`);
console.log('  已映射路由的 HTTP/IPC 消费值全部一致；桌面端无 Express 回落');
console.log('  错误路径：两条通道用户可见文案一致（HTTP code=VALIDATION_ERROR ｜ IPC code=IPC_ERROR，已知差异已登记）');
