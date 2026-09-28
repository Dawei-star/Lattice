/**
 * 格物 Lattice 的 winpack 启动入口。
 *
 * 为什么需要这个文件：winpack 的运行壳（main.cjs）只认识一个契约 ——
 * 入口模块导出 `start({ port, dataDir })`，由它自己负责把 HTTP 服务拉起来。
 * 而 Lattice 原有的入口 `server/src/index.js` 是一个「自启动脚本」，没有导出，
 * 且会直接 process.exit（配置非法时），不适合被别人的进程 import 进来。
 *
 * 这里做的事情，和 desktop/src/backend.js 在 Electron 主进程里做的是同一件：
 *   置好环境变量 → 打开库 → 跑迁移 → 首次启动灌示例数据 → 监听 → 等 /ready 就绪
 *
 * 两条硬约束（都踩过）：
 *   1. server/src/config 在**首次 import 时**读取并冻结 process.env，
 *      所以所有环境变量必须在动态 import 之前全部落地。
 *   2. 端口不能是 0。server 的 zod 校验要求 PORT ∈ [1, 65535]，
 *      传 0 会让进程在 import 阶段就 fail fast 退出。必须先探一个空闲端口。
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 产物里的位置：<app>/payload/packaging/winpack/entry.mjs → payload 根 */
const here = path.dirname(fileURLToPath(import.meta.url));
const payloadRoot = path.resolve(here, '..', '..');
const serverRoot = path.join(payloadRoot, 'server');
const webDistDir = path.join(payloadRoot, 'web', 'dist');

const importModule = (absPath) => import(pathToFileURL(absPath).href);

let runtime = null;

/** 探测端口能否独占绑定，成功返回端口号（0 表示交给系统分配），失败返回 null */
function probePort(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(null));
    probe.listen(port, '127.0.0.1', () => {
      const actual = probe.address().port;
      probe.close(() => resolve(actual));
    });
  });
}

async function pickPort(preferred) {
  return (await probePort(preferred)) ?? (await probePort(0));
}

function listen(expressApp, port) {
  return new Promise((resolve, reject) => {
    const server = expressApp.listen(port, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/**
 * 启动内嵌后端。
 * @param {{ port?: number, dataDir?: string }} options 由 winpack 运行壳传入
 * @returns {Promise<{ server: import('node:http').Server, port: number }>}
 */
export async function start({ port = 0, dataDir } = {}) {
  const writableRoot = dataDir || process.env.WINPACK_DATA_DIR || path.join(payloadRoot, 'data');
  const dbFile = path.join(writableRoot, 'data', 'lattice.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  const chosen = await pickPort(port || 5188);

  // ── 环境变量必须在下面所有动态 import 之前置好（约束 1） ──
  process.env.NODE_ENV = 'production';
  process.env.HOST = '127.0.0.1';
  process.env.PORT = String(chosen);
  process.env.DB_FILE = dbFile;
  // 显式指向前端产物：默认推导路径同样能命中，但写死可以免疫目录层级调整
  process.env.WEB_DIST_DIR = webDistDir;
  process.env.AUTO_MIGRATE = 'true';
  process.env.LOG_LEVEL = process.env.LATTICE_LOG_LEVEL || 'info';

  const firstRun = !fs.existsSync(dbFile);

  const { openDatabase, closeDatabase } = await importModule(path.join(serverRoot, 'src', 'db', 'index.js'));
  const { runMigrations } = await importModule(path.join(serverRoot, 'src', 'db', 'migrate.js'));
  const { createApp } = await importModule(path.join(serverRoot, 'src', 'app.js'));

  openDatabase();
  const { applied } = runMigrations();
  console.log(`[lattice] 数据库就绪：${dbFile}（本次应用迁移 ${applied.length} 个）`);

  // 首次启动灌一份示例知识库，免得用户面对一个空白界面
  if (firstRun) {
    try {
      const { seedSampleVault } = await importModule(path.join(serverRoot, 'src', 'db', 'seed.js'));
      const seeded = seedSampleVault();
      console.log(`[lattice] 首次启动，已写入示例知识库：${seeded.created} 篇笔记 / ${seeded.folders} 个目录`);
    } catch (error) {
      // 示例数据只是锦上添花，写不进去不该拖垮启动
      console.warn(`[lattice] 示例知识库写入失败（不影响正常使用）：${error?.message ?? error}`);
    }
  }

  const server = await listen(createApp(), chosen);
  runtime = { server, closeDatabase };

  // 退出前把连接收干净，避免留下未 checkpoint 的 WAL 文件
  process.on('exit', () => {
    try {
      closeDatabase();
    } catch {
      /* 退出路径上不抛 */
    }
  });

  console.log(`[lattice] 服务已监听：http://127.0.0.1:${chosen}`);
  return { server, port: chosen };
}

/** 主动收尾（运行壳当前不调用，留给外部复用） */
export function stop() {
  if (!runtime) return;
  try {
    runtime.server?.close();
  } catch {
    /* 已关闭 */
  }
  try {
    runtime.closeDatabase();
  } catch {
    /* 已关闭 */
  }
  runtime = null;
}
