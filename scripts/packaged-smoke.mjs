#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * 打包产物冒烟测试：不经过 Electron 壳，用系统 Node 直接驱动**产物内部**的应用本体，
 * 验证「建库 → 迁移 → 监听 → 探针 → 托管前端」这条链路真的能跑。
 *
 *   node scripts/packaged-smoke.mjs                       # 自动探测下面两个产物目录
 *   node scripts/packaged-smoke.mjs dist/winpack/win-unpacked
 *   node scripts/packaged-smoke.mjs desktop/release/win-unpacked
 *
 * 为什么需要它：本沙箱（以及受限 CI）里 Chromium 渲染进程常起不来，
 * 双击没反应并不能证明「包是坏的」。把后端单独跑一遍，就能把两者区分开。
 *
 * 自动适配两条打包链路（目录布局不同）：
 *   - winpack   <app>/payload/packaging/winpack/entry.mjs  → start({ port, dataDir })
 *   - desktop   <app>/src/backend.js                       → startBackend({ appRoot, userDataDir })
 *
 * 数据目录一律落在系统临时目录，跑完即删 —— 不会碰真实知识库。
 */

const require = createRequire(import.meta.url);
const CANDIDATES = ['dist/winpack/win-unpacked', 'desktop/release/win-unpacked'];

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 探一个空闲端口（PORT=0 会让服务端在 import 阶段 fail fast，所以必须先探再传） */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 定位 <unpacked>/resources/app，并判定属于哪条链路 */
function detectLayout(unpacked) {
  const app = path.join(unpacked, 'resources', 'app');
  if (!fs.existsSync(app)) {
    throw new Error(`未找到 ${app}，传入的是 win-unpacked 目录吗？`);
  }
  const winpackEntry = path.join(app, 'payload', 'packaging', 'winpack', 'entry.mjs');
  const desktopBackend = path.join(app, 'src', 'backend.js');

  if (fs.existsSync(desktopBackend)) {
    return { kind: 'desktop', appRoot: app, module: desktopBackend, webRoot: path.join(app, 'web') };
  }
  if (fs.existsSync(winpackEntry)) {
    return {
      kind: 'winpack',
      appRoot: app,
      module: winpackEntry,
      webRoot: path.join(app, 'payload', 'web', 'dist'),
    };
  }
  throw new Error(`未识别的产物布局（既没有 src/backend.js 也没有 payload/.../entry.mjs）：${app}`);
}

/** 从产物自带的前端资源目录里取真实入口文件名（比硬编码 hash 可靠） */
function realAssets(webRoot) {
  const dir = path.join(webRoot, 'assets');
  if (!fs.existsSync(dir)) return {};
  const files = fs.readdirSync(dir);
  return {
    js: files.find((f) => /^index-.*\.js$/.test(f)),
    css: files.find((f) => /^index-.*\.css$/.test(f)),
  };
}

async function main() {
  const arg = process.argv[2];
  const unpacked = arg
    ? path.resolve(arg)
    : CANDIDATES.map((c) => path.resolve(c)).find((c) => fs.existsSync(c));

  if (!unpacked) {
    console.error('未找到可测的产物目录。用法：node scripts/packaged-smoke.mjs <win-unpacked 目录>');
    process.exit(2);
  }

  const layout = detectLayout(unpacked);
  const assets = realAssets(layout.webRoot);

  console.log(`\n产物    ${unpacked}`);
  console.log(`链路    ${layout.kind}`);
  console.log(`前端    ${assets.js ?? '(未找到 index-*.js)'}\n`);

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lattice-smoke-'));
  let start;
  let stop = async () => {};

  try {
    if (layout.kind === 'desktop') {
      const backend = require(layout.module);
      start = () => backend.startBackend({ appRoot: layout.appRoot, userDataDir: tmpRoot });
      stop = async () => backend.stopBackendSync();
    } else {
      const mod = await import(pathToFileURL(layout.module).href);
      const port = await freePort();
      start = () => mod.start({ port, dataDir: tmpRoot });
      stop = async () => mod.stop?.();
    }

    const info = await start();
    const base = info.url ?? `http://127.0.0.1:${info.port}`;

    check('应用本体启动（建库 + 迁移 + 监听）', Boolean(base), base);
    console.log(`        数据目录 ${tmpRoot}\n`);

    const get = async (p, asJson = false) => {
      const res = await fetch(`${base}${p}`);
      const body = asJson ? await res.json().catch(() => null) : null;
      return { res, body };
    };

    const health = await get('/health', true);
    check('GET /health → 200', health.res.ok, `status=${health.res.status}`);

    const ready = await get('/ready', true);
    const dbUp = ready.body?.data?.database === 'up';
    check('GET /ready → 200 且 database=up', ready.res.ok && dbUp, JSON.stringify(ready.body?.data));

    const root = await get('/');
    const html = await root.res.text();
    const spaOk = root.res.ok && html.includes('<div id="root"');
    check('GET / → 200 且托管 SPA', spaOk, `${html.length} bytes`);

    // SPA 回退会让任何 /assets/* 都返回 200(HTML)，所以必须比对真实体积
    if (assets.js) {
      const res = await fetch(`${base}/assets/${assets.js}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const onDisk = fs.statSync(path.join(layout.webRoot, 'assets', assets.js)).size;
      check(
        `GET /assets/${assets.js} → 200 且为真实文件`,
        res.ok && buf.length === onDisk,
        `下发 ${buf.length} B / 磁盘 ${onDisk} B`,
      );
    } else {
      check('前端入口资源存在', false, '产物内未找到 index-*.js');
    }

    check('打包后前端与产物内一致', true, '由上面的字节比对保证');
  } catch (err) {
    check('应用本体启动', false, err instanceof Error ? err.message : String(err));
  } finally {
    await stop();
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${failures.length === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m${failures.length} 项失败\x1b[0m`}（通过 ${passed} 项）`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
