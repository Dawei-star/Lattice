/**
 * IPC 参数契约测试（P1-08 第 2 步 · 交付物 A）。
 *
 * 守住「映射表 args 构造器实际产出的键」与「Rust 命令形参」之间的漂移：
 * Tauri 2 默认把 JS 的 camelCase key 映射到 Rust 的 snake_case 形参，59 个命令
 * 均未使用 `rename_all`。多传键会让 invoke 报「未知参数」，漏传必填形参会让
 * 命令报错——两类都是「不报错、但运行时静默错」的隐患。
 *
 * 断言：
 *  ① 构造器产出的键必须都存在于该命令的 Rust 形参里；
 *  ② 该命令的必填形参（非 `Option<...>`）必须都被构造器提供；
 *  ③ 值为 null 也算「已提供」（按 Object.keys 口径）。
 *
 * 需要一个「万能 ctx」让构造器不返回 undefined；若某条路由对该 ctx 形态仍返回
 * undefined（说明它对本 ctx 不适用），跳过该路由并在汇总里列出，不因此失败。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_ROUTES } from '../src/api/ipc-routes.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(here);
const repoRoot = path.dirname(webRoot);

// ─────────────────────── 解析 Rust 命令形参 ───────────────────────

const rust = readFileSync(path.join(repoRoot, 'src-tauri/src/lib.rs'), 'utf8');

/** 深度感知地按分隔符切分（忽略 `<>`/`()`/`[]` 内的分隔符）。 */
function splitTopLevel(text, separator = ',') {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '<' || char === '(' || char === '[') depth += 1;
    else if (char === '>' || char === ')' || char === ']') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Rust snake_case 形参名 → 线缆上的 camelCase key。 */
function toCamel(name) {
  return name
    .split('_')
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

/** command → { all: Set, required: Set }（跳过 state / app 注入参数）。 */
function parseRustCommands(source) {
  const commands = new Map();
  const pattern = /#\[tauri::command\][\s\S]*?\bfn\s+([A-Za-z0-9_]+)\s*\(([\s\S]*?)\)\s*->/g;
  for (const match of source.matchAll(pattern)) {
    const [, name, paramsText] = match;
    const all = new Set();
    const required = new Set();
    for (const rawParam of splitTopLevel(paramsText)) {
      const param = rawParam.trim();
      if (!param) continue;
      const colon = param.indexOf(':');
      if (colon === -1) continue;
      const paramName = param.slice(0, colon).trim();
      const paramType = param.slice(colon + 1).trim();
      // Tauri 注入参数：State<'_, ...> 与 AppHandle（客户端不传）
      if (paramType.startsWith('State<') || /AppHandle\b/.test(paramType)) continue;
      const key = toCamel(paramName);
      all.add(key);
      if (!paramType.startsWith('Option<')) required.add(key);
    }
    commands.set(name, { all, required });
  }
  return commands;
}

const commands = parseRustCommands(rust);
assert.ok(commands.size >= 50, `只解析出 ${commands.size} 个 #[tauri::command]，疑似解析失效`);

// ─────────────────────── 万能 ctx 与键收集 ───────────────────────

/** 对任意属性返回非空字符串（params / query）。 */
function stringProxy() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        return `ctx-${String(prop)}`;
      },
    },
  );
}

const BODY_KEYS = [
  'id', 'title', 'content', 'properties', 'folderId', 'filePath', 'dryRun', 'confirmed',
  'secondConfirmed', 'actions', 'operationId', 'force', 'message', 'excludeId', 'findingIds',
  'staleDays', 'limit', 'planId', 'planHash', 'expectedCurrentHash', 'nodes', 'edges',
  'expectedHash', 'fromPath', 'toPath', 'name', 'skill', 'expert', 'type', 'path',
];

/** 对任意属性返回真值：布尔位 true，数组位非空数组，其余非空字符串。 */
function bodyProxy() {
  const truthy = (prop) => {
    if (prop === 'findingIds' || prop === 'actions') return ['ctx-item'];
    if (prop === 'nodes' || prop === 'edges') return [];
    if (prop === 'confirmed' || prop === 'secondConfirmed' || prop === 'dryRun' || prop === 'all') {
      return true;
    }
    if (prop === 'staleDays' || prop === 'limit') return 1;
    return `ctx-${String(prop)}`;
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        return truthy(prop);
      },
      has() {
        return true;
      },
      ownKeys() {
        return BODY_KEYS;
      },
      getOwnPropertyDescriptor(_target, prop) {
        return { configurable: true, enumerable: true, value: truthy(prop), writable: true };
      },
    },
  );
}

/** 构造器实际产出的键集合；返回 undefined 表示该路由对此 ctx 不适用。 */
function collectKeys(route, ctx) {
  if (typeof route.args !== 'function') return new Set();
  const args = route.args(ctx);
  if (args === undefined || args === null) return undefined;
  // Object.keys 口径：值为 null 的键也算「已提供」
  return new Set(Object.keys(args));
}

function routeLabel(route) {
  const pathText = route.path instanceof RegExp ? route.path.source : route.path;
  return `${route.method} ${pathText}`;
}

// ─────────────────────── 逐条断言 ───────────────────────

const ctx = {
  params: stringProxy(),
  query: stringProxy(),
  body: bodyProxy(),
  rawBody: new Uint8Array([1]),
};

const failures = [];
const skipped = [];
const covered = new Map(); // command -> { routes: number }

for (const route of IPC_ROUTES) {
  const keys = collectKeys(route, ctx);
  const label = routeLabel(route);
  if (keys === undefined) {
    skipped.push({ label, command: route.command, reason: '构造器对该万能 ctx 返回 undefined' });
    continue;
  }
  covered.set(route.command, { routes: (covered.get(route.command)?.routes ?? 0) + 1 });

  const shape = commands.get(route.command);
  assert.ok(shape, `进表项引用了 lib.rs 未定义的命令：${route.command}（${label}）`);

  for (const key of keys) {
    if (!shape.all.has(key)) {
      failures.push(
        `${label} → ${route.command}：args 产出多余键「${key}」（Rust 形参：${[...shape.all].join(', ') || '∅'}）`,
      );
    }
  }
  for (const key of shape.required) {
    if (!keys.has(key)) {
      failures.push(
        `${label} → ${route.command}：缺少必填形参「${key}」（args 产出：${[...keys].join(', ') || '∅'}）`,
      );
    }
  }
}

if (failures.length) {
  throw new Error(`IPC 参数契约校验失败（${failures.length} 项）：\n  - ${failures.join('\n  - ')}`);
}

// ─────────────────────── 覆盖汇总（非断言） ───────────────────────

console.log('ipc args contract tests passed');
console.log(
  `  覆盖路由 ${IPC_ROUTES.length - skipped.length} / ${IPC_ROUTES.length}，涉及命令 ${covered.size} 个`,
);
console.log(`  命令 → 参数集合比对结果（camelCase）：`);
for (const [command, { routes }] of [...covered.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const shape = commands.get(command);
  console.log(
    `    · ${command}（${routes} 条路由）：all={${[...shape.all].join(', ')}} required={${[...shape.required].join(', ') || '∅'}}`,
  );
}
if (skipped.length) {
  console.log(`  跳过路由 ${skipped.length} 条（构造器对万能 ctx 不适用）：`);
  for (const item of skipped) console.log(`    · ${item.label} → ${item.command}：${item.reason}`);
} else {
  console.log('  无跳过路由');
}
