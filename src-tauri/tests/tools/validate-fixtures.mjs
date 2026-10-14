/**
 * fixtures 自检器（P1-08）。
 *
 * 常驻意义：`src-tauri/tests/fixtures/` 是 Rust 侧断言的**唯一基准**，一旦它内部不自洽
 * （schema 与 data 不符、漏归一的时间戳、索引与实际 case 数量不符），Rust 断言就会
 * 变成假绿或假红。录制脚本自身只保证「写得出来」，本校验器保证「写出来的东西可信」。
 *
 * 用法：`node src-tauri/tests/tools/validate-fixtures.mjs`（根 package.json 有 verify:fixtures）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', 'fixtures');
const casesDir = path.join(fixtures, 'cases');

/** 与录制脚本约定的 schema 推导规则（对象 / 数组 / 标量 / null） */
function schemaOf(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return { type: 'array', element: value.length ? schemaOf(value[0]) : null, length: value.length };
  }
  if (typeof value === 'object') {
    const fields = {};
    for (const key of Object.keys(value)) fields[key] = schemaOf(value[key]);
    return { type: 'object', fields };
  }
  return { type: typeof value };
}

const problems = [];
const fail = (message) => problems.push(message);

// --- 1. 索引与实际产物一致 ---------------------------------------------------
const index = JSON.parse(readFileSync(path.join(fixtures, 'index.json'), 'utf8'));
const caseFiles = readdirSync(casesDir).filter((name) => name.endsWith('.json')).sort();
const indexedCommands = Object.values(index.domains ?? {}).flat().sort();

if (caseFiles.length !== index.coverage?.recorded) {
  fail(`index.coverage.recorded=${index.coverage?.recorded} 与实际 ${caseFiles.length} 个 case 不符`);
}
if (indexedCommands.length !== caseFiles.length) {
  fail(`index.domains 列出 ${indexedCommands.length} 个命令，实际 case ${caseFiles.length} 个`);
}
const duplicated = indexedCommands.filter((name, i) => indexedCommands.indexOf(name) !== i);
if (duplicated.length) fail(`index.domains 存在重复命令：${duplicated.join(', ')}`);

// --- 2. 逐 case 校验 ---------------------------------------------------------
const REQUIRED_KEYS = ['command', 'http', 'data', 'schema', 'volatilePaths'];
const ISO_TIMESTAMP = /20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const LONG_HEX = /\b[0-9a-f]{64}\b/;

for (const file of caseFiles) {
  const rel = `cases/${file}`;
  const raw = readFileSync(path.join(casesDir, file), 'utf8');
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch (error) {
    fail(`${rel} 不是合法 JSON：${error.message}`);
    continue;
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in entry)) fail(`${rel} 缺少必需字段 ${key}`);
  }
  if (entry.command !== path.basename(file, '.json')) {
    fail(`${rel} 的 command 字段（${entry.command}）与文件名不符`);
  }
  for (const key of ['method', 'path', 'status']) {
    if (entry.http?.[key] === undefined) fail(`${rel} 的 http.${key} 缺失`);
  }

  // schema 必须由 data 推导而来 —— 这条断了，Rust 侧断言就失去意义
  const recomputed = JSON.stringify(schemaOf(entry.data));
  if (recomputed !== JSON.stringify(entry.schema)) {
    fail(`${rel} 的 schema 与 data 不一致\n      stored     ${JSON.stringify(entry.schema).slice(0, 200)}\n      recomputed ${recomputed.slice(0, 200)}`);
  }

  // 归一化必须彻底，否则每次录制产物都不同
  if (ISO_TIMESTAMP.test(raw)) fail(`${rel} 残留未归一的 ISO 时间戳`);
  if (LONG_HEX.test(raw)) fail(`${rel} 残留未归一的 64 位十六进制哈希`);
}

// --- 3. seed 快照存在且非空 --------------------------------------------------
const vaultDir = path.join(fixtures, 'seed', 'vault');
let visibleFiles = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else visibleFiles += 1;
  }
})(vaultDir);
if (!visibleFiles) fail('seed/vault 为空，Rust 侧无法重建 Vault');

const manifest = JSON.parse(readFileSync(path.join(fixtures, 'seed', 'manifest.json'), 'utf8'));
for (const section of ['notes', 'folders']) {
  if (!Array.isArray(manifest[section]) || manifest[section].length === 0) {
    fail(`seed/manifest.json 的 ${section} 为空`);
  }
}

if (problems.length) {
  console.error(`fixtures 自检失败（${problems.length} 项）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('fixtures 自检通过');
console.log(`  case ${caseFiles.length} 个 · seed 可见文件 ${visibleFiles} 个 · 命令域 ${Object.keys(index.domains ?? {}).length} 个`);
console.log('  逐 case 校验：必需字段齐备 / command 与文件名一致 / schema 与 data 一致 / 无残留时间戳与哈希');
