/**
 * 前端 ↔ Rust 命令契约测试。
 *
 * 前端 `invoke('vault_xxx')` 里的命令名一旦和 Rust `generate_handler!` 注册的名字对不上，
 * 只会在应用运行时才炸（而且报错信息是「command not found」这类噪音）。
 * 这里直接用文本比对两侧名字，把这类漂移挡在提交前。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(here);
const repoRoot = path.dirname(webRoot);

const api = readFileSync(path.join(webRoot, 'src/api/native-vault.ts'), 'utf8');
const rust = readFileSync(path.join(repoRoot, 'src-tauri/src/lib.rs'), 'utf8');

const handlerBlock = rust.match(/generate_handler!\[([\s\S]*?)\]/);
assert.ok(handlerBlock, 'lib.rs 里找不到 generate_handler! 注册块');
const registered = new Set(
  handlerBlock[1]
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean),
);

const invoked = [...api.matchAll(/invoke<[^>]*>\(\s*'([a-z_]+)'/g)].map((match) => match[1]);
assert.ok(invoked.length >= 8, `native-vault.ts 里只解析出 ${invoked.length} 个命令，疑似解析失效`);

for (const command of invoked) {
  assert.ok(registered.has(command), `前端调用了 Rust 未注册的命令：${command}`);
}

// 索引能力必须真的接上：扫描与统计是新链路的关键命令。
for (const required of ['vault_scan', 'vault_index_stats', 'vault_search']) {
  assert.ok(invoked.includes(required), `native-vault.ts 缺少命令：${required}`);
  assert.ok(registered.has(required), `lib.rs 未注册命令：${required}`);
}

// 搜索返回的命中必须带摘要字段，否则侧栏会退化成「只有标题」。
assert.match(api, /excerpt:\s*string/, 'native-vault.ts 的检索结果类型应包含 excerpt');

console.log(`native-vault contract tests passed (${invoked.length} commands)`);
