/**
 * 映射表 ↔ Rust 注册表 一致性契约测试（P1-08 前置）。
 *
 * 守住三类漂移（都是「不报错、但运行时静默错」的类型）：
 *  1. 进表项的 command 名在 `generate_handler!` 里不存在 → 桌面态调不通；
 *  2. 进表项与排除项互相矛盾（同一条路由既说可用、又说排除）；
 *  3. 排除清单里写的「尚未实现」命令，其实已经被实现了 → 排除理由过期，应该回收进表。
 *
 * 另外把「注册了但前端两个通道都没引用」的命令打印出来，作为 P1-08 的待办视野。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_EXCLUDED_ROUTES, IPC_PENDING_COMMANDS, IPC_ROUTES } from '../src/api/ipc-routes.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(here);
const repoRoot = path.dirname(webRoot);

const rust = readFileSync(path.join(repoRoot, 'src-tauri/src/lib.rs'), 'utf8');

const handlerBlock = rust.match(/generate_handler!\[([\s\S]*?)\]/);
assert.ok(handlerBlock, 'lib.rs 里找不到 generate_handler! 注册块');
const registered = new Set(
  handlerBlock[1]
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean),
);
assert.ok(registered.size >= 50, `只解析出 ${registered.size} 个已注册命令，疑似解析失效`);

const failure = [];
function expect(condition, message) {
  if (!condition) failure.push(message);
}

// --- 1. 进表项的 command 必须已注册 -----------------------------------------
assert.ok(IPC_ROUTES.length >= 25, `映射表只有 ${IPC_ROUTES.length} 条，疑似被误删`);
for (const route of IPC_ROUTES) {
  expect(
    registered.has(route.command),
    `进表项引用了 Rust 未注册的命令：${route.command}（${route.method} ${route.path}）`,
  );
}

// --- 2. 进表项内部不得重复 ---------------------------------------------------
const seen = new Map();
for (const route of IPC_ROUTES) {
  const key = `${route.method} ${route.path instanceof RegExp ? route.path.source : route.path}`;
  expect(!seen.has(key), `映射表存在重复路由：${key}（${seen.get(key)} 与 ${route.command} 争抢）`);
  seen.set(key, route.command);
}

// 匹配优先级：动态段若排在静态段之前，会把静态路由整条吞掉（matchIpcRoute 取首个命中）
const routeIndex = new Map(IPC_ROUTES.map((route, index) => [route, index]));
for (const dynamic of IPC_ROUTES.filter((route) => route.path instanceof RegExp)) {
  for (const staticRoute of IPC_ROUTES.filter((route) => typeof route.path === 'string')) {
    if (staticRoute.method !== dynamic.method) continue;
    if (!dynamic.path.test(staticRoute.path)) continue;
    expect(
      routeIndex.get(staticRoute) < routeIndex.get(dynamic),
      `静态路由 ${staticRoute.method} ${staticRoute.path}（${staticRoute.command}）必须排在会吞掉它的动态路由 ${dynamic.path}（${dynamic.command}）之前`,
    );
  }
}

// --- 3. 进表项与排除项必须互斥 ----------------------------------------------
for (const entry of IPC_EXCLUDED_ROUTES) {
  const [method, template] = entry.split(' ');
  for (const route of IPC_ROUTES) {
    if (route.method !== method) continue;
    const hit = typeof route.path === 'string' ? route.path === template : route.path.test(template);
    expect(
      !hit,
      `路由同时出现在进表项与排除清单：${entry}（进表命令 ${route.command}）——要么进表、要么排除`,
    );
  }
}

// --- 4. 排除清单的「缺命令」必须确实未注册 ----------------------------------
for (const command of IPC_PENDING_COMMANDS) {
  expect(
    !registered.has(command),
    `${command} 已经注册进 generate_handler!，说明 P1-04/P1-08 已补齐它——请把对应路由从排除清单移进 IPC_ROUTES`,
  );
}

// --- 5. 口径自洽 -------------------------------------------------------------
expect(
  IPC_ROUTES.length + IPC_EXCLUDED_ROUTES.length === 88,
  `进表 ${IPC_ROUTES.length} + 排除 ${IPC_EXCLUDED_ROUTES.length} ≠ 88（W1 纳入 /ai/settings GET+PUT；E2 纳入技能导入预览与导出；E3 纳入 MCP 状态/测试/工具清单/Registry；E4 纳入专家导出/角色卡导入、Claude 技能发现与 elicitation 回复）`,
);

if (failure.length) {
  throw new Error(`映射表契约校验失败（${failure.length} 项）：\n  - ${failure.join('\n  - ')}`);
}

// --- 覆盖报告（非断言） ------------------------------------------------------
const referenced = new Set([
  ...IPC_ROUTES.map((route) => route.command),
  ...IPC_PENDING_COMMANDS,
]);
const unreferenced = [...registered].filter((command) => !referenced.has(command));

console.log('ipc routes contract tests passed');
console.log(`  映射表 ${IPC_ROUTES.length} 条 / 排除 ${IPC_EXCLUDED_ROUTES.length} 条 / 已注册 ${registered.size} 个命令`);
console.log(`  静态优先与去重校验通过；排除清单中的 ${IPC_PENDING_COMMANDS.length} 个待实现命令确认未注册`);
if (unreferenced.length) {
  console.log(`  注册但前端两通道都未引用（${unreferenced.length} 个，P1-08 待办视野）：`);
  for (const command of unreferenced) console.log(`    · ${command}`);
}
