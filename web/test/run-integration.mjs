import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * undici（Node fetch）拒绝连接的端口。本机动态端口范围可能从 1024 起，
 * 随机端口一旦落到这些值，测试对临时后端的 fetch 就会直接报 `bad port`。
 * 必须声明在 reservePort() 调用之前（模块顶层会立刻调用它）。
 */
const BLOCKED_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..', '..');
const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-web-integration-'));
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const backend = spawn(process.execPath, [path.join(projectRoot, 'server', 'src', 'index.js')], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    DB_FILE: path.join(runtimeRoot, 'lattice.db'),
    VAULT_DIR: path.join(runtimeRoot, 'vault'),
    AUTO_MIGRATE: 'true',
    WEB_DIST_DIR: path.join(runtimeRoot, 'missing-web-dist'),
  },
  stdio: 'inherit',
});

try {
  await waitUntilReady(baseUrl);
  await run(process.execPath, [path.join(testDir, 'canvas-navigation.test.mjs')]);
  await run(process.execPath, [path.join(testDir, 'canvas-delete.test.mjs')]);
  await run(process.execPath, [path.join(testDir, 'canvas-pan.test.mjs')]);
  await run(process.execPath, [path.join(testDir, 'run-smoke.mjs')]);
  // 附件开关验收同样需要一个真实后端；这里一并托管，避免它退回硬编码的 127.0.0.1:5177
  // 而在「没另外起 dev server」的干净机器上必然 ECONNREFUSED。
  await run(process.execPath, [path.join(testDir, 'attachments-toggle.test.mjs')]);
} finally {
  backend.kill();
  await once(backend, 'exit').catch(() => {});
  // 清理临时目录不应决定验收结论：本环境的删除保护 shim（由 NODE_OPTIONS 注入）在单轮
  // 删除数超过配额后会拒绝递归删除，使这个 finally reject → 整条链以非 0 退出，而
  // **没有任何断言失败**（输出里既无断言报错也无 server 日志），极易被误读成产品回归。
  // 检查全部通过时，清理失败只告警。
  await fs.rm(runtimeRoot, { recursive: true, force: true }).catch((error) => {
    console.warn(
      `[integration] 临时目录清理失败（不影响验收结论，可忽略环境删除配额）：${error.code ?? error.message} ${runtimeRoot}`,
    );
  });
}

/**
 * undici（Node fetch）拒绝连接的端口。本机动态端口范围可能从 1024 起，
 * 随机端口一旦落到这些值，测试对临时后端的 fetch 就会直接报 `bad port`。
 */
async function reservePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    if (!BLOCKED_PORTS.has(port)) return port;
  }
  throw new Error('20 次尝试都没拿到未被 undici 屏蔽的端口');
}

async function waitUntilReady(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${url}/ready`);
      if (response.ok) return;
    } catch {
      // The server is still initializing its database and vault projection.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('前端集成测试的临时后端未在 8 秒内就绪');
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, LATTICE_BASE_URL: baseUrl },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(args.at(-1))} failed (${signal ?? `exit ${code}`})`));
    });
  });
}
