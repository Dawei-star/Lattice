'use strict';
/**
 * 内嵌后端：把 server/ 的 Express 应用直接跑在 Electron 主进程里。
 *
 * 之所以不用子进程，是因为 Electron 自带的 Node（当前 24.x）已经内置 node:sqlite，
 * 与项目的「零原生依赖」选型完全对齐 —— 不需要额外打包 node.exe，
 * 也不需要用户机器上预装 Node。
 *
 * 关键点：server/src/config 在**首次 import 时**读取并校验 process.env 并冻结配置，
 * 因此所有环境变量必须在动态 import 之前设置完毕。
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** 首选的本地端口，占用时回退到系统分配的临时端口 */
const PREFERRED_PORT = 5188;

let runtime = null;

/** 从候选位置里找出 server/ 源码根目录（兼容开发态与打包态） */
function resolveServerRoot(appRoot) {
  const candidates = [
    path.join(appRoot, 'server'), // 打包态：server 随 files 一并进入 app 目录
    path.resolve(appRoot, '..', 'server'), // 开发态：desktop/ 的上一级
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'src', 'app.js'))) ?? null;
}

/** 找出前端构建产物目录（内含 index.html） */
function resolveWebDist(appRoot) {
  const candidates = [
    path.join(appRoot, 'web'), // 打包态
    path.resolve(appRoot, '..', 'web', 'dist'), // 开发态
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}

/** 探测某个端口能否独占绑定，成功返回端口号（0 表示交给系统分配），失败返回 null */
function probePort(port) {
  return new Promise((resolve) => {
    const probe = require('node:net').createServer();
    probe.once('error', () => resolve(null));
    probe.listen(port, '127.0.0.1', () => {
      const actual = probe.address().port;
      probe.close(() => resolve(actual));
    });
  });
}

async function pickPort() {
  return (await probePort(PREFERRED_PORT)) ?? (await probePort(0));
}

function listen(expressApp, port) {
  return new Promise((resolve, reject) => {
    const server = expressApp.listen(port, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/** 轮询 /ready，确认 HTTP 与数据库都真的就绪 */
async function waitUntilReady(url, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${url}/ready`);
      if (res.ok) return await res.json();
    } catch {
      // 尚未起来，继续重试
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('后端启动后未能在预期时间内通过就绪探针');
}

const importModule = (absPath) => import(pathToFileURL(absPath).href);

/**
 * 启动内嵌后端。
 * @param {{ appRoot: string, userDataDir: string, vaultDir?: string, log?: (msg: string) => void }} options
 */
async function startBackend({ appRoot, userDataDir, vaultDir, log = () => {} }) {
  const serverRoot = resolveServerRoot(appRoot);
  if (!serverRoot) {
    throw new Error(`未能在 ${appRoot} 下找到后端源码（server/src/app.js）`);
  }

  const webDistDir = resolveWebDist(appRoot);
  if (!webDistDir) {
    throw new Error('未找到前端构建产物（缺少 index.html），请先在 web/ 下执行构建');
  }

  const dbFile = path.join(userDataDir, 'data', 'lattice.db');
  // 先判断是不是首次启动，再交给 openDatabase 去建库
  const firstRun = !fs.existsSync(dbFile);
  const port = await pickPort();

  process.env.NODE_ENV = 'production';
  process.env.HOST = '127.0.0.1';
  process.env.PORT = String(port);
  process.env.DB_FILE = dbFile;
  if (vaultDir) process.env.VAULT_DIR = vaultDir;
  process.env.WEB_DIST_DIR = webDistDir;
  process.env.AUTO_MIGRATE = 'true';
  process.env.LOG_LEVEL = process.env.LATTICE_LOG_LEVEL || 'info';

  const { openDatabase, closeDatabase } = await importModule(path.join(serverRoot, 'src', 'db', 'index.js'));
  const { runMigrations } = await importModule(path.join(serverRoot, 'src', 'db', 'migrate.js'));
  const { config } = await importModule(path.join(serverRoot, 'src', 'config', 'index.js'));
  const { createApp } = await importModule(path.join(serverRoot, 'src', 'app.js'));
  const { resolveVaultDir } = await importModule(path.join(serverRoot, 'src', 'vault', 'config.js'));
  const { VaultAdapter } = await importModule(path.join(serverRoot, 'src', 'vault', 'vault.adapter.js'));
  const { reconcileVault } = await importModule(path.join(serverRoot, 'src', 'vault', 'sync.js'));
  const { watchVault } = await importModule(path.join(serverRoot, 'src', 'vault', 'watcher.js'));
  const { publishVaultEvent } = await importModule(path.join(serverRoot, 'src', 'vault', 'events.js'));

  openDatabase();
  const { applied } = runMigrations();

  const resolvedVaultDir = resolveVaultDir(config.vaultDir);
  const vault = new VaultAdapter(resolvedVaultDir);
  const indexed = await reconcileVault(vault, { mode: 'full' });
  log(`vault indexed: ${JSON.stringify(indexed)}`);
  const stopVaultWatcher = watchVault(resolvedVaultDir, {
    log: (event) => log(`vault changed: ${JSON.stringify(event)}`),
    onChange: publishVaultEvent,
  });
  log(`数据库就绪：${dbFile}（本次应用迁移 ${applied.length} 个）`);

  // 首次启动灌入示例知识库，避免用户面对一个空白库
  const expressApp = createApp();
  const httpServer = await listen(expressApp, port);
  const url = `http://127.0.0.1:${port}`;

  await waitUntilReady(url);
  log(`后端已就绪：${url}（前端产物 ${webDistDir}）`);

  runtime = { httpServer, closeDatabase, stopVaultWatcher, url, dbFile };

  return { url, port, dbFile, webDistDir, firstRun, migrationsApplied: applied.length };
}

/** 同步停机：先断开 HTTP，再 checkpoint 并关闭数据库 */
function stopBackendSync() {
  if (!runtime) return;

  try {
    runtime.httpServer.close();
  } catch {
    // 已关闭则忽略
  }
  try {
    runtime.stopVaultWatcher?.();
  } catch {
    // Ignore a watcher that is already closed during shutdown.
  }
  try {
    runtime.closeDatabase();
  } catch {
    // 库已关闭或 checkpoint 失败都不应阻塞退出
  }
  runtime = null;
}

module.exports = { startBackend, stopBackendSync };
