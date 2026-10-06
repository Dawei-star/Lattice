#!/usr/bin/env node
/**
 * 产物冒烟：不启动 Chromium，直接用系统 Node 驱动打包产物内部的「后端本体」。
 *
 * 目的：在「界面起不来」（宿主沙箱拦掉 Chromium 子进程）的环境里，仍然能证明
 * **产物本身是好的** —— 相对路径解析得到、依赖齐全、数据库能建、迁移能跑、
 * 前端资源能正确下发、写接口真能落盘。
 *
 * 用法：
 *   node scripts/packaged-smoke.mjs                       # 自动探测两条链路的产物目录
 *   node scripts/packaged-smoke.mjs desktop/release/win-unpacked
 *   node scripts/packaged-smoke.mjs desktop/release/win-unpacked --workspace-token=<16位以上>
 *                                                         # 额外验证 /api 的工作区令牌边界
 *
 * 两条链路的启动契约不同，脚本会自动识别布局：
 *   desktop  → <app>/src/backend.js          startBackend({ appRoot, userDataDir })
 *   winpack  → <app>/payload/packaging/winpack/entry.mjs   start({ port, dataDir })
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 后端的结构化日志默认 info，会把每次请求都打到 stdout，淹没冒烟结论。
process.env.LATTICE_LOG_LEVEL = process.env.LATTICE_LOG_LEVEL || 'warn';

const CANDIDATES = [
  'desktop/release/win-unpacked',
  'dist/winpack/win-unpacked',
];

// 可选：带上 --workspace-token=<值> 再跑一次，就能同时验证「工作区访问令牌」这道边界
// 在打包产物里真的生效（默认不设令牌，即桌面版的实际配置）。
const TOKEN_FLAG = '--workspace-token=';
const tokenArg = process.argv.slice(2).find((arg) => arg.startsWith(TOKEN_FLAG));
const workspaceToken = tokenArg ? tokenArg.slice(TOKEN_FLAG.length) : '';
const productArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failures.push(`${name}${detail ? ` \u2014 ${detail}` : ''}`);
    console.log(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

function detectLayout(productDir) {
  const appRoot = path.join(productDir, 'resources', 'app');
  if (fs.existsSync(path.join(appRoot, 'src', 'backend.js'))) {
    return { kind: 'desktop', appRoot };
  }
  const winpackEntry = path.join(appRoot, 'payload', 'packaging', 'winpack', 'entry.mjs');
  if (fs.existsSync(winpackEntry)) {
    return { kind: 'winpack', appRoot, entry: winpackEntry };
  }
  throw new Error(`无法识别产物布局（既没有 src/backend.js 也没有 payload/.../entry.mjs）：${productDir}`);
}

function locateProduct(explicit) {
  if (explicit) return path.resolve(REPO, explicit);
  const found = CANDIDATES.map((p) => path.join(REPO, p)).find((p) => fs.existsSync(p));
  if (!found) throw new Error(`未找到产物目录，候选：${CANDIDATES.join(' / ')}`);
  return found;
}

/** 从 index.html 里取出引用的资源文件名 */
function assetRefs(html) {
  return [...html.matchAll(/assets\/(index-[^"']+\.(?:js|css))/g)].map((m) => m[1]);
}

/** 递归列出 .js，跳过目录本身与 node_modules / 开发态 .mimosa */
function walkJavaScriptFiles(directory) {
  const out = [];
  if (!fs.existsSync(directory)) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.mimosa') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walkJavaScriptFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 去掉块注释与行注释，避免注释里提到的路径被误判成 import 说明符 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 找出包内**解析不到真实文件**的相对 import。
 *
 * 起因（2026-10-02 实测）：「确定性文件助手」把 `fc-core.mjs` 放在仓库根 `scripts/`，
 * 而 `server/src/modules/files/files.service.js` 与 `server/src/modules/ai/ai.operations.js`
 * 都写死 `'../../../../scripts/fc-core.mjs'`。打包只拷 `../server/src`，包内没有 `scripts/`，
 * 于是这两条 ESM 静态 import 抛 ERR_MODULE_NOT_FOUND → **整个后端启动即崩**（前端白屏），
 * 而不是某个接口 404。源码目录里一切正常、模块单测也全绿，只有按**包内布局**重算才暴露。
 * 这条判据放在启动后端**之前**跑：否则「后端起不来」只会呈现成一句无信息的启动失败。
 */
function findUnresolvedRelativeImports(appRoot) {
  const roots = [path.join(appRoot, 'server', 'src'), path.join(appRoot, 'src')];
  const unresolved = [];
  for (const file of roots.flatMap(walkJavaScriptFiles)) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]*)['"]/g)) {
      if (!fs.existsSync(path.resolve(path.dirname(file), match[1]))) {
        unresolved.push(`${path.relative(appRoot, file).replaceAll('\\', '/')} → ${match[1]}`);
      }
    }
  }
  return unresolved;
}

/** 在数据目录里找出运行时建的库文件（两条链路的布局不同，靠搜而不是靠猜） */
function findDatabase(dataDir) {
  const stack = [dataDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.db')) return full;
    }
  }
  return null;
}

/** 读出 schema_migrations 里已应用的版本号 */
function readAppliedMigrations(dataDir) {
  const dbFile = findDatabase(dataDir);
  if (!dbFile) return [];
  const db = new DatabaseSync(dbFile);
  try {
    return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * 查 SQLite 里某个表是否带指定列 / 是否存在。
 *
 * 「迁移文件在包内且被记进 schema_migrations」**不等于**「表结构真的变了」：
 * ALTER TABLE / CREATE TABLE 写错、被后续迁移覆盖、或磁盘上的库是从更早的版本
 * 拷来的，都会让版本号齐全但列/表缺失——而应用启动不报错，只是到用时才炸。
 */
function inspectSchema(dataDir, { table, column = null }) {
  const dbFile = findDatabase(dataDir);
  if (!dbFile) return { exists: false, columns: [] };
  const db = new DatabaseSync(dbFile);
  try {
    const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all();
    return { exists: columns.length > 0, columns: columns.map((row) => row.name) };
  } catch {
    return { exists: false, columns: [] };
  } finally {
    db.close();
  }
}

async function main() {
  const productDir = locateProduct(productArg);
  const layout = detectLayout(productDir);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-packaged-smoke-'));
  const vaultDir = path.join(dataDir, 'vault');

  // 必须在 startBackend 之前置好：server 的 config 在首次 import 时读取并冻结 process.env。
  if (workspaceToken) process.env.WORKSPACE_ACCESS_TOKEN = workspaceToken;

  console.log(`产物：${productDir}`);
  console.log(`布局：${layout.kind}`);
  console.log(`数据：${dataDir}（跑完即删）`);
  console.log(`工作区令牌：${workspaceToken ? '已设置（验证 /api 边界）' : '未设置（桌面版默认配置）'}\n`);

  let stop = () => {};
  let port = null;

  // ---- 包完整性：相对 import 必须全部可达（放在启动后端之前，否则只会得到「起不来」）----
  const unresolvedImports = findUnresolvedRelativeImports(layout.appRoot);
  check('包内所有相对 import 都能解析到真实文件',
    unresolvedImports.length === 0,
    unresolvedImports.length
      ? `解析失败：${unresolvedImports.join(' | ')}（有源码跨目录引用仓库根 scripts/，需补进 electron-builder.yml 的 files 段）`
      : `已扫描 server/src 与 src 的 .js`);

  // ---- 包完整性：内置 MCP Server 及其依赖必须随包发出 ----
  // 设置页「导出配置」的 Lattice 条目指向包内 scripts/mcp-server/server.mjs。
  // 漏打不崩任何进程（后端/页面都正常），只有外部客户端拉起配置时报「文件不存在」，
  // 属于最阴的静默失效 —— 与 fc-core.mjs 同一级别，必须在冒烟里立案。
  const mcpServerFile = path.join(layout.appRoot, 'scripts', 'mcp-server', 'server.mjs');
  const mcpSdkFile = path.join(layout.appRoot, 'scripts', 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
  check('内置 MCP Server 及其 SDK 依赖随包发出',
    fs.existsSync(mcpServerFile) && fs.existsSync(mcpSdkFile),
    fs.existsSync(mcpServerFile)
      ? (fs.existsSync(mcpSdkFile) ? 'server.mjs 与 @modelcontextprotocol/sdk 都在' : '缺 scripts/mcp-server/node_modules（SDK 依赖未打包）')
      : '缺 scripts/mcp-server/server.mjs（需补进 electron-builder.yml 的 files 段）');

  try {
    if (layout.kind === 'desktop') {
      const mod = await import(pathToFileURL(path.join(layout.appRoot, 'src', 'backend.js')).href);
      const started = await mod.startBackend({ appRoot: layout.appRoot, userDataDir: dataDir, vaultDir });
      port = started.port;
      stop = mod.stopBackendSync ?? (() => {});
    } else {
      const mod = await import(pathToFileURL(layout.entry).href);
      const started = await mod.start({ port: 0, dataDir });
      port = started.port;
      stop = () => started.server?.close();
    }

    const base = `http://127.0.0.1:${port}`;
    /** 公开端点：探针与前端静态资源，不该要求令牌（30s 兜底超时防挂死） */
    const get = (p) => fetch(`${base}${p}`, { signal: AbortSignal.timeout(30_000) });
    /** 业务 API：设置了令牌时自动带上 X-Workspace-Token */
    const api = (p, init = {}) => fetch(`${base}${p}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(workspaceToken ? { 'X-Workspace-Token': workspaceToken } : {}) },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    /**
     * 只看 SSE 响应头就断开。
     * /api/vault/events 是长连接，`await res.text()` 会永远挂住；而 fetch 在**收到响应头**时
     * 就已 resolve，所以拿到 status/content-type 后立刻 abort，既不挂死也验到了路由。
     * 组合一个 15s 超时：响应头一直不到时 probe 也能收场（controller.abort 只在头到达后才执行）。
     */
    const probeSse = async (p, headers = {}) => {
      const controller = new AbortController();
      try {
        const res = await fetch(`${base}${p}`, {
          headers,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        const info = { status: res.status, type: res.headers.get('content-type') ?? '' };
        controller.abort();
        return info;
      } catch {
        return { status: 0, type: '' };
      }
    };

    // ---- 探针 ----
    const health = await get('/health');
    check('GET /health 存活', health.ok, `status=${health.status}`);
    const ready = await get('/ready');
    check('GET /ready 打库成功', ready.ok, `status=${ready.status}`);

    // ---- 迁移：新增的 .sql 有没有真的随包发出并被应用 ----
    // 这是最容易悄悄烂掉的一环：包内 migrations 少一个文件时，一切"看起来正常"，
    // 直到某个新功能在真机上因为缺索引/缺表而崩。
    const migrationsDir = path.join(layout.appRoot, 'server', 'src', 'migrations');
    const onDisk = fs.existsSync(migrationsDir)
      ? fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
      : [];
    const appliedVersions = readAppliedMigrations(dataDir);
    check('包内迁移文件都被应用',
      onDisk.length > 0 && appliedVersions.length === onDisk.length,
      `包内 ${onDisk.length} 个=[${onDisk.map((n) => n.replace(/\.sql$/, '')).join(', ')}] ` +
      `已应用 ${appliedVersions.length} 个=[${appliedVersions.join(', ')}]`);

    // 「迁移版本号齐全」只说明 .sql 被跑过；这里再钉住新结构真的建出来了。
    // 008 给 notes 加了属性投影列——知识健康扫描与 Inbox 过滤都直接 SELECT 它，
    // 列不存在时 /api/review/health 会整片 500；009 建了对话度量表；
    // 007 给 ai_sessions 加了 expert_id，会话按专家隔离全靠这一列（缺列时
    // listSessionPage 的 WHERE expert_id = ? 直接抛错，会话列表整片 500）。
    const propertiesColumn = inspectSchema(dataDir, { table: 'notes', column: 'properties_json' });
    const metricsTable = inspectSchema(dataDir, { table: 'ai_chat_metrics' });
    const sessionsTable = inspectSchema(dataDir, { table: 'ai_sessions' });
    check('迁移 008 的 notes.properties_json 投影列真的建出来了',
      propertiesColumn.exists && propertiesColumn.columns.includes('properties_json'),
      `notes 列=[${propertiesColumn.columns.join(', ') || '表不存在'}]`);
    check('迁移 009 的 ai_chat_metrics 表真的建出来了',
      metricsTable.exists,
      `ai_chat_metrics 列=[${metricsTable.columns.join(', ') || '表不存在'}]`);
    check('迁移 007 的 ai_sessions.expert_id 专家归属列真的建出来了',
      sessionsTable.exists && sessionsTable.columns.includes('expert_id'),
      `ai_sessions 列=[${sessionsTable.columns.join(', ') || '表不存在'}]`);

    // ---- 前端与资源（不能只看 / 返回 200） ----
    const indexRes = await get('/');
    const indexHtml = await indexRes.text();
    check('GET / 返回前端 index.html', indexRes.ok && indexHtml.includes('<div id="root"'),
      `status=${indexRes.status} type=${indexRes.headers.get('content-type')}`);

    const refs = assetRefs(indexHtml);
    check('index.html 引用了构建资源', refs.length >= 2, `找到 ${refs.length} 个：${refs.join(', ')}`);

    const repoIndex = fs.readFileSync(path.join(REPO, 'web', 'dist', 'index.html'), 'utf8');
    const repoRefs = assetRefs(repoIndex);
    check('包内前端与仓库 web/dist 是同一版', refs.join() === repoRefs.join(),
      `包内=[${refs.join(', ')}] 仓库=[${repoRefs.join(', ')}]（不一致说明打的是旧 dist）`);

    for (const ref of refs) {
      const res = await get(`/assets/${ref}`);
      const body = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') ?? '';
      const disk = path.join(REPO, 'web', 'dist', 'assets', ref);
      const diskSize = fs.existsSync(disk) ? fs.statSync(disk).size : -1;
      const expectType = ref.endsWith('.css') ? 'css' : 'javascript';
      check(`GET /assets/${ref} 是真文件`,
        res.ok && type.includes(expectType) && body.length === diskSize,
        `status=${res.status} type=${type} 包内=${body.length}B 仓库=${diskSize}B`);
    }

    // ---- 前端 bundle 内嵌的 APP_VERSION 必须等于包版本 ----
    // 版本号散落 5 处（根/server/web/desktop 的 package.json + SettingsModal.jsx 里硬编码的
    // APP_VERSION），而 APP_VERSION 还是「检查更新」的比较基准。上游改了 SettingsModal
    // 却没重建 dist 时，包内与仓库的 index.html hash 都是旧值，上面那条「同一版」判断照样
    // 通过，但界面会显示旧版本号、更新比较也拿旧基准 —— 只有直接读 bundle 里的版本串才拦得住。
    // 实战踩过：SettingsModal 在 vite 构建窗口内被改，产物落到 0.1.2，而 exe 已叫 0.1.3。
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
    const [vMajor, vMinor] = pkgVersion.split('.');
    const jsRef = refs.find((r) => r.endsWith('.js'));
    const packedJs = jsRef ? path.join(layout.appRoot, 'web', 'assets', jsRef) : null;
    const packedJsText = packedJs && fs.existsSync(packedJs) ? fs.readFileSync(packedJs, 'utf8') : '';
    const embeddedVersions = [...new Set(packedJsText.match(new RegExp(`\\b${vMajor}\\.${vMinor}\\.\\d+\\b`, 'g')) ?? [])];
    check('包内前端 bundle 内嵌版本号 == 包版本',
      embeddedVersions.length === 1 && embeddedVersions[0] === pkgVersion,
      `包版本=${pkgVersion} bundle 内=[${embeddedVersions.join(', ') || '未找到'}]`);

    // ---- PWA 静态资源（manifest + service worker）必须随包发出且能从根路径取到 ----
    // web/public/ 下的 manifest.webmanifest 与 sw.js 由 vite **原样拷**进 web/dist 根目录，
    // index.html 用 <link rel="manifest" href="/manifest.webmanifest"> 引用。
    // 这类「public 目录里的非 bundle 文件」最容易被忽略：assets/ 有 hash 与体积校验，
    // 它们没有；漏发后页面看起来完全正常，只有「安装为应用」「离线壳缓存」静默失效。
    // service worker 更苛刻——必须落在**站点根**才能拿到覆盖全站的 scope，路径错位即功能作废。
    const pwaFiles = ['sw.js', 'manifest.webmanifest'];
    for (const name of pwaFiles) {
      const packedFile = path.join(layout.appRoot, 'web', name);
      const repoFile = path.join(REPO, 'web', 'dist', name);
      const same = fs.existsSync(packedFile) && fs.existsSync(repoFile)
        && fs.readFileSync(packedFile).equals(fs.readFileSync(repoFile));
      check(`PWA 资源 ${name} 随包发出且与仓库 web/dist 逐字节一致`, same,
        `包内=${fs.existsSync(packedFile) ? '有' : '缺失'} 仓库=${fs.existsSync(repoFile) ? '有' : '缺失'}`
        + (fs.existsSync(packedFile) && fs.existsSync(repoFile) && !same ? ' 内容不一致' : ''));
    }

    // 「文件在包内」不等于「能取到」——静态托管若把根级非 assets 文件漏掉，页面上仍是 404。
    const manifestRes = await get('/manifest.webmanifest');
    const manifestType = manifestRes.headers.get('content-type') ?? '';
    check('GET /manifest.webmanifest 能下发，且 index.html 确实引用了它',
      manifestRes.ok && indexHtml.includes('manifest.webmanifest'),
      `status=${manifestRes.status} type=${manifestType} index引用=${indexHtml.includes('manifest.webmanifest')}`);

    const swRes = await get('/sw.js');
    const swType = swRes.headers.get('content-type') ?? '';
    check('GET /sw.js 在站点根能下发（service worker scope 依赖根路径）',
      swRes.ok && /javascript|ecmascript/i.test(swType),
      `status=${swRes.status} type=${swType}`);

    // ---- MCP 插件市场的品牌 logo 必须随包发出且能从根路径取到 ----
    // 与 PWA 资源同一类风险：`web/public/mcp-logos/*.svg` 由 vite **原样拷**进 web/dist 根下的
    // `mcp-logos/`，设置页用绝对路径 `/mcp-logos/<name>.svg` 引用。它们不在 assets/ 里、
    // 没有 hash 与体积校验，漏发时后端与页面一切正常，只有市场卡片的品牌图标静默裂图。
    // 判据不数「有几个文件」（那是魔法数字），而是从**市场目录源码**里取出被引用的 logo 集合
    // 逐个核对：新增条目引用了没拷进 dist 的 logo（忘放文件 / 改了名）时能被精确指出来。
    const catalogSource = fs.readFileSync(path.join(REPO, 'web', 'src', 'settings', 'mcpMarketplace.js'), 'utf8');
    const referencedLogos = [...new Set([...catalogSource.matchAll(/LOGO\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))].sort();
    const logoProblems = [];
    for (const name of referencedLogos) {
      const packedFile = path.join(layout.appRoot, 'web', 'mcp-logos', `${name}.svg`);
      const repoFile = path.join(REPO, 'web', 'dist', 'mcp-logos', `${name}.svg`);
      if (!fs.existsSync(packedFile)) logoProblems.push(`${name}.svg 未随包发出`);
      else if (!fs.existsSync(repoFile)) logoProblems.push(`${name}.svg 不在仓库 web/dist`);
      else if (!fs.readFileSync(packedFile).equals(fs.readFileSync(repoFile))) logoProblems.push(`${name}.svg 与仓库不一致`);
    }
    check('市场目录引用的品牌 logo 全部随包发出且与仓库 web/dist 逐字节一致',
      referencedLogos.length > 0 && logoProblems.length === 0,
      logoProblems.length ? logoProblems.join('；') : `覆盖 ${referencedLogos.length} 个 logo`);

    const logoRes = await get('/mcp-logos/mcp.svg');
    const logoType = logoRes.headers.get('content-type') ?? '';
    check('GET /mcp-logos/mcp.svg 能从站点根下发为 svg',
      logoRes.ok && /svg/i.test(logoType),
      `status=${logoRes.status} type=${logoType}`);

    // ---- 桌面壳是否与仓库同版 ----
    // desktop/ 在 .gitignore 的 `!` 白名单里、且常常还没 `git add`，所以「改了壳没重打」
    // 用 git diff 根本看不出来，只能逐文件比字节。实战踩过：`vault:open-file` 已经支持
    // `.canvas`，而包内还是只认 `.md` 的旧版 —— 画布右键「在系统中打开」在产物里必失效。
    if (layout.kind === 'desktop') {
      const repoShellDir = path.join(REPO, 'desktop', 'src');
      const packedShellDir = path.join(layout.appRoot, 'src');
      const stale = [];
      if (fs.existsSync(repoShellDir)) {
        for (const name of fs.readdirSync(repoShellDir).filter((n) => n.endsWith('.js')).sort()) {
          const repoFile = path.join(repoShellDir, name);
          const packedFile = path.join(packedShellDir, name);
          const same = fs.existsSync(packedFile) && fs.readFileSync(repoFile).equals(fs.readFileSync(packedFile));
          if (!same) stale.push(name);
        }
      }
      check('包内桌面壳 src/*.js 与仓库逐字节一致', stale.length === 0,
        stale.length ? `落后/缺失：${stale.join(', ')}（改了 desktop/src 但没重打）` : '');

      // ---- 桌面壳的「可打开扩展名」白名单必须与服务端附件清单同源 ----
      // main.js 的 OPENABLE_FILE_EXTENSIONS 与 vault.attachments.js 的 MIME_BY_EXTENSION
      // 是同一份约定的两个副本（注释里明确要求保持同步）。只改一边就会出现
      // 「附件列表里显示了、点开却打不开」这类静默失效 —— 两个文件各自都「没错」，
      // 逐字节比对也各自通过，只有把两份清单放到一起比才拦得住。
      // 约定：服务端清单必须被桌面白名单完全覆盖，且白名单只多出 .md / .canvas。
      const shellMainPath = path.join(layout.appRoot, 'src', 'main.js');
      const attachPath = path.join(layout.appRoot, 'server', 'src', 'modules', 'vault', 'vault.attachments.js');
      const extractExts = (text) => [...new Set(text.match(/'\.(?:[a-z0-9]+)'/g) ?? [])]
        .map((m) => m.replace(/'/g, '').toLowerCase());
      if (fs.existsSync(shellMainPath) && fs.existsSync(attachPath)) {
        const shellText = fs.readFileSync(shellMainPath, 'utf8');
        const attachText = fs.readFileSync(attachPath, 'utf8');
        const shellBlock = shellText.match(/OPENABLE_FILE_EXTENSIONS\s*=\s*\[([\s\S]*?)\];/);
        const attachBlock = attachText.match(/MIME_BY_EXTENSION\s*=\s*new Map\(\[([\s\S]*?)\]\);/);
        const shellExts = new Set(shellBlock ? extractExts(shellBlock[1]) : []);
        // 只从 `['.ext', 'mime']` 行里取扩展名，避免把 MIME 串里的其它内容带进来。
        const attachExts = new Set(
          (attachBlock ? attachBlock[1].match(/\['\.[a-z0-9]+'/gi) ?? [] : [])
            .map((m) => m.replace(/\[|'/g, '').toLowerCase()),
        );
        const missing = [...attachExts].filter((e) => !shellExts.has(e)).sort();
        const extra = [...shellExts].filter((e) => !attachExts.has(e)).sort();
        check('桌面壳可打开扩展名覆盖服务端附件清单（且只多 .md/.canvas）',
          attachExts.size > 0 && missing.length === 0 && extra.join() === '.canvas,.md',
          `服务端 ${attachExts.size} 项 / 桌面 ${shellExts.size} 项；缺=${missing.join(',') || '无'}；多=${extra.join(',') || '无'}`);
      } else {
        check('桌面壳可打开扩展名覆盖服务端附件清单（且只多 .md/.canvas）', false,
          `缺少文件：${!fs.existsSync(shellMainPath) ? 'src/main.js ' : ''}${!fs.existsSync(attachPath) ? 'vault.attachments.js' : ''}`);
      }
    }

    // ---- 开发态痕迹不得进包 ----
    // `.mimosa/` 是宿主开发工具的钩子状态目录：hook-status/*.json 含本机绝对路径，
    // hook-state/*.source 是源码基线快照。它会散落在 server/src、web/dist、desktop/src
    // 这些「整目录拷贝」的位置，不排掉就随包发出去。electron-builder.yml 用 '!**/.mimosa/**' 排除。
    const scannedRoots = layout.kind === 'desktop'
      ? ['server', 'web', 'src']
      : ['server', 'web', 'src', 'payload'];
    const leaked = [];
    const walkForMimosa = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name === '.mimosa') leaked.push(path.relative(layout.appRoot, full).replaceAll('\\', '/'));
        else walkForMimosa(full);
      }
    };
    for (const root of scannedRoots) walkForMimosa(path.join(layout.appRoot, root));
    check('包内不含开发态痕迹（.mimosa/ 会话状态）', leaked.length === 0,
      leaked.length ? `泄漏目录：${leaked.join(', ')}` : `已扫描 ${scannedRoots.join('/')}`);

    // ---- SPA 回退：不存在的资源会「假装 200」，必须靠 type/体积识破 ----
    const ghost = await get('/assets/index-00000000.js');
    const ghostBody = Buffer.from(await ghost.arrayBuffer());
    const ghostType = ghost.headers.get('content-type') ?? '';
    check('不存在的资源走 SPA 回退（返回 HTML 而非 JS）',
      ghostType.includes('html') || !ghost.ok,
      `status=${ghost.status} type=${ghostType} 体积=${ghostBody.length}B`);

    // ---- 工作区访问令牌边界（新增的 server/src/middleware/workspaceAuth.js 是否真的在包里管事）----
    // 只在显式传了 --workspace-token 时验证：默认（桌面版）不设令牌，/api 本就该是开放的。
    if (workspaceToken) {
      const anonymous = await get('/api/meta/overview');
      check('设置令牌后匿名访问 /api 被拒（401）', anonymous.status === 401,
        `status=${anonymous.status}`);
      const authorized = await api('/api/meta/overview');
      check('携带 X-Workspace-Token 可正常访问 /api', authorized.ok,
        `status=${authorized.status}`);
      const wrong = await fetch(`${base}/api/meta/overview`, {
        headers: { 'X-Workspace-Token': `${workspaceToken}-wrong` },
        signal: AbortSignal.timeout(30_000),
      });
      check('令牌错误同样被拒（401）', wrong.status === 401, `status=${wrong.status}`);
      check('探针与前端资源不要求令牌（/health、/ready、/ 均可达）',
        health.ok && ready.ok && indexRes.ok,
        `health=${health.status} ready=${ready.status} /=${indexRes.status}`);
    }

    // ---- SSE 事件流与一次性票据（/api/workspace/sse-ticket + /api/vault/events）----
    // EventSource 不能带自定义请求头，所以设计成「先用长期令牌换 30 秒一次性票据，
    // 再用 ?sseTicket= 打开事件流」，避免长期令牌进 URL（浏览器历史 / 代理日志）。
    // 这条链路横跨 workspace 模块、vault 模块，以及 app.js 的挂载顺序 —— SSE 路由必须挂在
    // authenticateWorkspace **之前**，否则请求还到不了票据校验就被 `/api` 中间件拦掉。
    if (workspaceToken) {
      const ticketRes = await api('/api/workspace/sse-ticket', { method: 'POST' });
      const ticketBody = ticketRes.ok ? await ticketRes.json().catch(() => null) : null;
      const ticket = ticketBody?.data?.ticket ?? ticketBody?.ticket ?? '';
      check('POST /api/workspace/sse-ticket 能换到一次性票据',
        ticketRes.ok && Boolean(ticket), `status=${ticketRes.status} 票据=${ticket ? '有' : '无'}`);

      const anonSse = await probeSse('/api/vault/events');
      check('设置令牌后，无票据直连 /api/vault/events 被拒（401）',
        anonSse.status === 401, `status=${anonSse.status}`);

      const ticketSse = await probeSse(`/api/vault/events?sseTicket=${encodeURIComponent(ticket)}`);
      check('带一次性票据可打开 SSE 事件流（200 + text/event-stream）',
        ticketSse.status === 200 && ticketSse.type.includes('text/event-stream'),
        `status=${ticketSse.status} type=${ticketSse.type}`);

      // 只验「票据能用」的话，可重放的实现也会通过 —— 必须验一次性语义（命中即核销）。
      const replaySse = await probeSse(`/api/vault/events?sseTicket=${encodeURIComponent(ticket)}`);
      check('同一票据二次使用被拒（一次性，防重放）',
        replaySse.status === 401, `status=${replaySse.status}`);
    } else {
      const sse = await probeSse('/api/vault/events');
      check('默认（无令牌）下 /api/vault/events 直接可开（200 + text/event-stream）',
        sse.status === 200 && sse.type.includes('text/event-stream'),
        `status=${sse.status} type=${sse.type}`);
    }

    // ---- API ----
    const overview = await api('/api/meta/overview');
    check('GET /api/meta/overview', overview.ok, `status=${overview.status}`);
    const graph = await api('/api/graph');
    check('GET /api/graph', graph.ok, `status=${graph.status}`);

    // ---- 新增服务端模块是否真的入包 ----
    // 更新的服务端模块最容易「写进源码但漏进包」：路由文件在、但它 import 的
    // 错误类/服务文件少一个，运行时就是 500；而如果整个模块没入包，则是 404。
    // SPA 回退显式排除 /api/，所以「非 404」足以证明路由已挂载。
    // 网络不可达时该接口会返回 502（GitHub 代理失败），属预期，不算失败。
    const updateRoute = await api('/api/update/check?current=0.0.0', {
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const updateStatus = updateRoute?.status ?? 0;
    check('GET /api/update/check 路由已挂载（非 404）',
      updateStatus !== 404 && updateStatus !== 0,
      `status=${updateStatus}（502=代理不到 GitHub，属预期）`);

    // ---- 各服务端模块的「入包清单」----
    // 每个模块挑一条最轻的 GET，断言「非 404」即可证明它的 router 已随包挂载。
    // 判据成立的前提是 SPA 回退显式排除 /api/（见 server/src/app.js），未知 /api/* 必为 404。
    // 挑的都是无入参/只读端点，避免把「参数缺失 422」误判成「没入包」。
    const MODULE_PROBES = [
      ['folders', '/api/folders'],
      ['files', '/api/files/log?limit=1'],
      ['tags', '/api/tags'],
      ['search', '/api/search?q=smoke'],
      ['jobs', '/api/jobs'],
      ['mcp', '/api/mcp/info'],
      ['experts', '/api/experts'],
      ['review', '/api/review/health'],
      ['vault', '/api/vault/info'],
      ['ai', '/api/ai/settings'],
    ];
    const missingModules = [];
    for (const [name, probe] of MODULE_PROBES) {
      const res = await api(probe).catch(() => null);
      if (!res || res.status === 404) missingModules.push(`${name}(${probe}→${res?.status ?? 'ERR'})`);
    }
    check('各服务端模块路由都已入包（非 404）', missingModules.length === 0,
      missingModules.length ? `缺失：${missingModules.join(', ')}` : `覆盖 ${MODULE_PROBES.length} 个模块`);

    // ---- MCP 能力清单的语义指纹 ----
    // `/api/mcp/info` 已从「未开启写入时把 3 个写工具从数组里删掉（只剩 7 条）」改为
    // **返回全量 11 条工具并逐条带 `enabled`**（写工具默认 enabled=false），另附
    // enabledToolCount / writeToolCount / writesEnvVar。设置页据此才能同时展示「现在可用」
    // 与「开启后可用」。旧包同样是 200，路由探针抓不到这种语义回退 —— 只能读响应体。
    const mcpInfoRes = await api('/api/mcp/info');
    let mcpInfo = null;
    try { mcpInfo = (await mcpInfoRes.json()).data ?? null; } catch { mcpInfo = null; }
    const mcpTools = Array.isArray(mcpInfo?.tools) ? mcpInfo.tools : [];
    const mcpNames = mcpTools.map((tool) => tool.name);
    const mcpWriteTools = mcpTools.filter((tool) => tool.write === true);
    const mcpReadTools = mcpTools.filter((tool) => tool.write === false);
    check('MCP info 返回全量工具并逐条标注 enabled（默认只读：写工具未启用）',
      mcpTools.length === 11
        && mcpNames.includes('search_by_tag')
        && mcpWriteTools.length === 3
        && mcpWriteTools.every((tool) => tool.enabled === false)
        && mcpReadTools.length === 8
        && mcpReadTools.every((tool) => tool.enabled === true)
        && mcpInfo.enabledToolCount === mcpReadTools.length
        && mcpInfo.writeToolCount === 3
        && mcpInfo.writesEnabled === false
        && mcpInfo.writesEnvVar === 'LATTICE_MCP_ALLOW_WRITES',
      `tools=${mcpTools.length} write=${mcpWriteTools.length} enabled=${mcpInfo?.enabledToolCount ?? '?'} `
      + `env=${mcpInfo?.writesEnvVar ?? '?'} 名单=[${mcpNames.join(', ') || '空'}]`);

    // ---- 知识健康中心（review 模块）的扫描语义指纹 ----
    // `/api/review/health` 的前端契约是固定的 6 个分类键 + `summary.counts` 汇总：
    // 知识健康中心按 key 渲染卡片、按 counts 决定「需要处理多少条」。若服务端正文缺键
    // （例如某个分类忘了导出、或读 properties 的投影列没迁到），页面会静默少一块面板 ——
    // 路由探针只看非 404，抓不到这种回退。
    const healthRes = await api('/api/review/health?limit=5');
    let healthReport = null;
    try { healthReport = (await healthRes.json()).data ?? null; } catch { healthReport = null; }
    const HEALTH_CATEGORY_KEYS = ['inbox', 'brokenLinks', 'isolated', 'stale', 'duplicates', 'incomplete'];
    const healthCategories = healthReport?.categories ?? null;
    const missingCategoryKeys = healthCategories
      ? HEALTH_CATEGORY_KEYS.filter((key) => !Array.isArray(healthCategories[key]))
      : HEALTH_CATEGORY_KEYS;
    const counts = healthReport?.summary?.counts ?? null;
    check('GET /api/review/health 返回 6 个知识分类与自洽的汇总计数',
      healthRes.ok
        && healthCategories !== null
        && missingCategoryKeys.length === 0
        && counts !== null
        && HEALTH_CATEGORY_KEYS.every((key) => counts[key] === healthCategories[key].length)
        && healthReport.summary.total === HEALTH_CATEGORY_KEYS.reduce((sum, key) => sum + counts[key], 0)
        && healthReport.limits?.perCategory === 5
        && Number.isInteger(healthReport.noteCount),
      `status=${healthRes.status} noteCount=${healthReport?.noteCount ?? '?'} `
      + `缺失分类=[${missingCategoryKeys.join(', ') || '无'}] `
      + `counts=${counts ? JSON.stringify(counts) : '?'}`);
    check('知识健康扫描的 limit 参数被服务端强制（每类不超过上限）',
      healthRes.ok
        && healthCategories !== null
        && HEALTH_CATEGORY_KEYS.every((key) => healthCategories[key].length <= 5),
      healthCategories
        ? `各类长度=[${HEALTH_CATEGORY_KEYS.map((key) => `${key}:${healthCategories[key].length}`).join(', ')}]`
        : `status=${healthRes.status}`);

    // ---- AI 会话：分页元数据 + 专家隔离 ----
    // 这两件事都靠「迁移 007 的 ai_sessions.expert_id」+「listSessionPage 的 meta」实现。
    // 语义回退时接口照样 200，只是 meta 消失、或不同专家的会话串在一起 ——
    // 路由探针（非 404）与「GET /api/ai/settings」都抓不到，必须读 body。
    const SESSION_EXPERT = 'general';
    const sessionListRes = await api(`/api/ai/sessions?expertId=${SESSION_EXPERT}&limit=5&offset=0`);
    let sessionPage = null;
    try { sessionPage = await sessionListRes.json(); } catch { sessionPage = null; }
    const sessionItems = Array.isArray(sessionPage?.data) ? sessionPage.data : null;
    const sessionMeta = sessionPage?.meta ?? null;
    const sessionMetaComplete = sessionMeta !== null
      && ['total', 'limit', 'offset', 'hasMore'].every((key) => sessionMeta[key] !== undefined)
      && Number.isInteger(sessionMeta.total)
      && sessionMeta.limit === 5
      && sessionMeta.offset === 0
      && typeof sessionMeta.hasMore === 'boolean';
    check('GET /api/ai/sessions 返回分页元数据（total/limit/offset/hasMore）',
      sessionListRes.ok && sessionItems !== null && sessionMetaComplete,
      `status=${sessionListRes.status} items=${sessionItems?.length ?? '?'} `
      + `meta=${sessionMeta ? JSON.stringify(sessionMeta) : '缺失'}`);

    // 专家隔离：新建一个非 general 专家的会话，再用 default 专家列一次。
    // 若查询条件里的 expert_id 被丢掉（回归到「列全部」），下面这条立刻报红。
    const OTHER_EXPERT = 'smoke-expert';
    const otherSessionRes = await api('/api/ai/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'packaged-smoke-other-expert', expertId: OTHER_EXPERT }),
    });
    let otherSession = null;
    try { otherSession = (await otherSessionRes.json()).data ?? null; } catch { otherSession = null; }
    const otherListRes = await api(`/api/ai/sessions?expertId=${SESSION_EXPERT}&limit=200&offset=0`);
    let otherPageItems = null;
    try { otherPageItems = (await otherListRes.json()).data ?? null; } catch { otherPageItems = null; }
    const leakedSessions = Array.isArray(otherPageItems)
      ? otherPageItems.filter((item) => item?.expertId && item.expertId !== SESSION_EXPERT)
      : null;
    check('AI 会话按 expert_id 隔离（别的专家的会话不会串到当前专家列表）',
      otherSessionRes.ok
        && otherSession !== null
        && otherSession.expertId === OTHER_EXPERT
        && Array.isArray(otherPageItems)
        && leakedSessions.length === 0,
      `create status=${otherSessionRes.status} expertId=${otherSession?.expertId ?? '?'} `
      + `当前专家列表=[${(otherPageItems ?? []).map((item) => `${item?.expertId}:${item?.title}`).join(', ') || '空'}]`);
    check('AI 会话列表对非法 expertId 直接拒绝（正则白名单在服务端生效）',
      await (async () => {
        const bad = await api('/api/ai/sessions?expertId=NOT_VALID');
        return bad.status === 422;
      })(),
      `expertId=NOT_VALID 的响应码应为 422`);
    if (otherSession?.id) {
      await api(`/api/ai/sessions/${encodeURIComponent(otherSession.id)}`, { method: 'DELETE' });
    }

    // ---- 内置专家 / Skill 是**运行时数据文件**，必须随包发出且真能加载 ----
    // `server/src/modules/experts/builtin/` 里是 6 个 expert `.json` + 7 个 skill 目录
    // （每个必须同时有 SKILL.md 与 skill.json）。registry 用 `<包>/server/src/modules/experts/builtin`
    // 读它们，而 `listExperts()` / `listSkills()` 把读取异常**静默吞掉** —— 漏文件不会报错，
    // 只会「专家中心里少个人」或某个 skill 的 `available` 变成 false。所以这里三层一起核：
    // 文件集合、逐字节一致、以及**走 HTTP 真把它们加载出来**（最贴近用户看到的结果）。
    const builtinDir = path.join(REPO, 'server', 'src', 'modules', 'experts', 'builtin');
    const repoExpertIds = fs.readdirSync(path.join(builtinDir, 'experts'))
      .filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, '')).sort();
    const repoSkillIds = fs.readdirSync(path.join(builtinDir, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const packedBuiltin = path.join(layout.appRoot, 'server', 'src', 'modules', 'experts', 'builtin');
    const builtinFiles = [
      ...repoExpertIds.map((id) => `experts/${id}.json`),
      ...repoSkillIds.flatMap((id) => [`skills/${id}/SKILL.md`, `skills/${id}/skill.json`]),
    ];
    const builtinMismatch = builtinFiles.filter((rel) => {
      const packedFile = path.join(packedBuiltin, rel);
      const repoFile = path.join(builtinDir, rel);
      return !fs.existsSync(packedFile) || !fs.readFileSync(packedFile).equals(fs.readFileSync(repoFile));
    });
    check('内置专家 / Skill 资源随包发出且与仓库 server/src 逐字节一致',
      repoExpertIds.length > 0 && repoSkillIds.length > 0 && builtinMismatch.length === 0,
      builtinMismatch.length
        ? `缺失/不一致：${builtinMismatch.join(', ')}`
        : `覆盖 ${repoExpertIds.length} 个专家 / ${repoSkillIds.length} 个 Skill`);

    const expertsRes = await api('/api/experts');
    let expertsPayload = [];
    try { expertsPayload = (await expertsRes.json()).data ?? []; } catch { expertsPayload = []; }
    const expertsById = new Map(expertsPayload.map((expert) => [expert.id, expert]));
    const missingExperts = repoExpertIds.filter((id) => !expertsById.has(id));
    const unavailableSkills = [];
    for (const expert of expertsPayload) {
      for (const skill of expert.skills ?? []) {
        if (skill.available !== true) unavailableSkills.push(`${expert.id}→${skill.id}`);
      }
    }
    check('GET /api/experts 能加载出全部内置专家，且绑定的 Skill 全部 available',
      expertsRes.ok && expertsPayload.length > 0
        && missingExperts.length === 0 && unavailableSkills.length === 0,
      `status=${expertsRes.status} 加载 ${expertsPayload.length} 个 `
      + `缺失=[${missingExperts.join(', ') || '无'}] 不可用绑定=[${unavailableSkills.join(', ') || '无'}]`);

    const skillsRes = await api('/api/experts/skills');
    let skillsPayload = [];
    try { skillsPayload = (await skillsRes.json()).data ?? []; } catch { skillsPayload = []; }
    const loadedSkillIds = new Set(skillsPayload.map((skill) => skill.id));
    const missingSkills = repoSkillIds.filter((id) => !loadedSkillIds.has(id));
    check('GET /api/experts/skills 能加载出全部内置 Skill',
      skillsRes.ok && skillsPayload.length > 0 && missingSkills.length === 0,
      `status=${skillsRes.status} 加载 ${skillsPayload.length} 个 缺失=[${missingSkills.join(', ') || '无'}]`);

    // 正文只有真读进来才算数：SKILL.md 与 skill.json 缺任何一个，readSkillFromDir 都返回 null。
    const sampleSkillId = repoSkillIds[0];
    const sampleSkillRes = await api(`/api/experts/skills/${sampleSkillId}`);
    let sampleSkill = null;
    try { sampleSkill = (await sampleSkillRes.json()).data ?? null; } catch { sampleSkill = null; }
    check(`GET /api/experts/skills/${sampleSkillId} 能读到 SKILL.md 正文与内容哈希`,
      sampleSkillRes.ok
        && typeof sampleSkill?.content === 'string' && sampleSkill.content.trim().length > 0
        && typeof sampleSkill?.contentHash === 'string' && sampleSkill.contentHash.length === 64,
      `status=${sampleSkillRes.status} 正文字符=${sampleSkill?.content?.length ?? 0} hash=${sampleSkill?.contentHash?.slice(0, 8) ?? '无'}`);

    // `server/src/modules/ai/ai.mcp.js` 在**模块加载期**裸导入 @modelcontextprotocol/sdk，
    // 由 `<包>/node_modules` 解析。后端既然已经起来了，这里再核一次文件级存在 ——
    // 这条挂掉就是整站白屏，而「后端没起来」在冒烟里只会呈现成一句无信息的启动失败。
    const sdkManifest = path.join(layout.appRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
    check('包内 app/node_modules 含 @modelcontextprotocol/sdk（ai.mcp.js 的裸导入）',
      fs.existsSync(sdkManifest),
      sdkManifest.replace(layout.appRoot, '<app>'));

    // ---- 新增查询参数确实进了包（用「非法值必须被拒」当指纹） ----
    // `listQuery` 新增了 inboxStatus 枚举。若包里是旧 schema（没这个 key），zod 默认会
    // **剥掉**未知键而不是报错，所以「合法值返回 200」两种 schema 都成立、鉴别不了。
    // 反过来问「非法值会不会被拒」才有区分度：新 schema → 422，旧 schema → 200。
    // ⚠️ 本项目 ValidationError 的 HTTP 状态是 **422**（见 server/src/lib/errors.js），不是 400。
    const inboxBad = await api('/api/notes?inboxStatus=不存在的状态');
    check('GET /api/notes?inboxStatus=<非法> 被 422 拒（证明新 schema 在包里）',
      inboxBad.status === 422, `status=${inboxBad.status}`);
    const inboxOk = await api('/api/notes?inboxStatus=captured');
    check('GET /api/notes?inboxStatus=captured 合法值放行', inboxOk.ok, `status=${inboxOk.status}`);

    // ---- 写路径：建库 → 迁移 → 落盘 ----
    const title = `产物冒烟-${Date.now()}`;
    const created = await api('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, content: 'packaged smoke' }),
    });
    const createdBody = created.ok ? await created.json() : null;
    const noteId = createdBody?.data?.id ?? createdBody?.id;
    check('POST /api/notes 写入成功', created.ok && Boolean(noteId), `status=${created.status}`);

    if (noteId) {
      const read = await api(`/api/notes/${noteId}`);
      const readBody = read.ok ? await read.json() : null;
      const readTitle = readBody?.data?.title ?? readBody?.title;
      check('GET /api/notes/:id 读回一致', read.ok && readTitle === title, `title=${readTitle}`);

      // ---- Inbox：打标 → 按状态筛选（走完新增特性的整条链路） ----
      // Inbox 没有独立资源，它就是「笔记的 properties.type='inbox' + status」加上
      // `list()` 里的服务端过滤。所以纯 API 就能验它是否真的在包里成立：
      // 打上 captured → 该状态能筛到；换成 processed → 立刻筛不到。
      // 只验「合法值返回 200」是不够的（旧 schema 也返回 200），必须验**筛选真的生效**。
      const marked = await api(`/api/notes/${noteId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ properties: { type: 'inbox', status: 'captured' } }),
      });
      check('PATCH /api/notes/:id 写入 Inbox properties', marked.ok, `status=${marked.status}`);
      const captured = await api('/api/notes?inboxStatus=captured&limit=200');
      const capturedBody = captured.ok ? await captured.json() : null;
      const capturedItems = capturedBody?.data ?? [];
      check('GET /api/notes?inboxStatus=captured 能筛到刚打标的笔记',
        captured.ok && capturedItems.some((n) => n.id === noteId),
        `status=${captured.status} 命中=${capturedItems.length} total=${capturedBody?.meta?.total}`);
      const processed = await api('/api/notes?inboxStatus=processed&limit=200');
      const processedBody = processed.ok ? await processed.json() : null;
      const processedItems = processedBody?.data ?? [];
      check('GET /api/notes?inboxStatus=processed 不含该笔记（状态过滤真的生效）',
        processed.ok && !processedItems.some((n) => n.id === noteId),
        `status=${processed.status} 命中=${processedItems.length}`);

      const del = await api(`/api/notes/${noteId}`, { method: 'DELETE' });
      check('DELETE /api/notes/:id 清理成功', del.ok, `status=${del.status}`);
    }

    // ---- 画布：PUT 建 → DELETE 删 → 再删（幂等） ----
    // 走的是一整条「新路由 + 新 service 方法」的链路：router / controller / service
    // 任一个没进包，这里都不会是 200。
    // ⚠️ 2026-10-01 起 `canvas.service.remove()` 改成**幂等**：文件已不在磁盘时按成功返回
    // （让前端能清掉过期条目）。所以「重复删除」的正确期望是 **200 + data.deleted === true**，
    // 不再是 404。判据反而更强 —— 路由没挂载时兜底处理器返回 404 且 message 含「接口不存在」，
    // 两者不可能同时满足。
    const canvasPath = `产物冒烟画布-${Date.now()}.canvas`;
    const canvasCreate = await api(`/api/canvas?path=${encodeURIComponent(canvasPath)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodes: [], edges: [] }),
    });
    check('PUT /api/canvas 新建画布', canvasCreate.ok, `status=${canvasCreate.status}`);
    if (canvasCreate.ok) {
      const canvasDelete = await api(`/api/canvas/file?path=${encodeURIComponent(canvasPath)}`, { method: 'DELETE' });
      const deleteBody = canvasDelete.ok ? await canvasDelete.json() : null;
      check('DELETE /api/canvas/file 删除画布', canvasDelete.ok && deleteBody?.data?.deleted === true,
        `status=${canvasDelete.status} body=${JSON.stringify(deleteBody)?.slice(0, 120)}`);
      const canvasAgain = await api(`/api/canvas/file?path=${encodeURIComponent(canvasPath)}`, { method: 'DELETE' });
      const againBody = await canvasAgain.json().catch(() => null);
      check('重复删除已不存在的画布仍返回 200（幂等）',
        canvasAgain.status === 200 && againBody?.data?.deleted === true,
        `status=${canvasAgain.status} body=${JSON.stringify(againBody)?.slice(0, 140)}`);
      // 阴性对照：证明「404 + 接口不存在」这条判别信号真的存在、没被别的东西吃掉。
      // 缺了它，上面几条「非 404 / 是 200」的断言就无法排除「兜底也返回 200」的可能。
      const ghost = await api('/api/canvas/这个路由不存在', { method: 'DELETE' });
      const ghostBody = await ghost.json().catch(() => null);
      check('对照：不存在的 /api 路由仍返回 404 + 「接口不存在」',
        ghost.status === 404 && JSON.stringify(ghostBody ?? '').includes('接口不存在'),
        `status=${ghost.status} body=${JSON.stringify(ghostBody)?.slice(0, 140)}`);
    }

    // ---- 画布 Obsidian 兼容：读取时归一化（本轮新增） ----
    // Obsidian 的 .canvas 与本项目格式有三处不兼容：edge 用 fromNode/toNode（本项目 from/to）、
    // 颜色是 "1"~"6" / #hex（本项目命名色）、存在 group 节点（无 text 只有 label）。
    // 「读取时归一化」是 canvas.service.js 里的新代码路径 —— 直接往 vault 放一份 Obsidian 格式
    // 的文件再 GET，就能证明包里是**新版** service（旧版会原样返回 fromNode、颜色仍为 "1"，
    // 边还会因查不到端点被整条丢弃）。
    const obsidianCanvasPath = `产物冒烟-Obsidian-${Date.now()}.canvas`;
    const obsidianDoc = {
      nodes: [
        { id: 'group-1', type: 'group', x: 0, y: 0, width: 1600, height: 900, label: '分组标题' },
        { id: 'card-a', type: 'text', text: '卡片 A', x: 40, y: 80, width: 320, height: 200, color: '1' },
        { id: 'card-b', type: 'text', text: '卡片 B', x: 420, y: 120, width: 260, height: 160, color: '#9b59b6' },
      ],
      edges: [{ id: 'edge-1', fromNode: 'card-a', toNode: 'card-b', fromSide: 'right', toSide: 'left' }],
    };
    fs.writeFileSync(path.join(vaultDir, obsidianCanvasPath), JSON.stringify(obsidianDoc));
    const obsidianRes = await api(`/api/canvas?path=${encodeURIComponent(obsidianCanvasPath)}`).catch(() => null);
    const obsidianBody = obsidianRes?.ok ? await obsidianRes.json().catch(() => null) : null;
    const obsidianNodes = obsidianBody?.data?.nodes ?? [];
    const obsidianEdges = obsidianBody?.data?.edges ?? [];
    const nodeColor = (id) => obsidianNodes.find((n) => n.id === id)?.color;
    check('Obsidian 画布边端点归一化（fromNode/toNode → from/to）',
      obsidianEdges.length === 1 && obsidianEdges[0].from === 'card-a' && obsidianEdges[0].to === 'card-b',
      `edges=${JSON.stringify(obsidianEdges)?.slice(0, 120)}`);
    check('Obsidian 画布颜色归一化（"1"→red、#hex 按色相就近映射）',
      nodeColor('card-a') === 'red' && nodeColor('card-b') === 'purple',
      `card-a=${nodeColor('card-a') ?? '无'} card-b=${nodeColor('card-b') ?? '无'}`);
    check('Obsidian group 节点保留并排在最前（label → text）',
      obsidianNodes[0]?.id === 'group-1' && obsidianNodes[0]?.type === 'group' && obsidianNodes[0]?.text === '分组标题',
      `nodes[0]=${JSON.stringify(obsidianNodes[0])?.slice(0, 140)}`);
    try { fs.rmSync(path.join(vaultDir, obsidianCanvasPath), { force: true }); } catch { /* 清理失败不影响结论 */ }

    // ---- 附件上传：按笔记归组（新 folder 参数）+ 目录穿越防护 ----
    // 本轮给 POST /api/vault/attachments 加了可选 folder（客户端指定 attachments/ 下的子目录）。
    // 这是**由客户端控制、且直接参与路径构造**的新参数，所以两面都要验：
    //   ① 正常归组：文件真的落到 attachments/<folder>/ 下；
    //   ② 穿越防护：上跳 / 绝对路径 / 超深嵌套都被服务端逐段清洗（sanitizeAttachmentFolder
    //      与文件名同规则），**绝不逃出 attachments/**，且深度截到 4 段。
    const ATTACHMENT_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const attachName = `产物冒烟-${Date.now()}.png`;
    const uploadAttachment = (folder) => api(
      `/api/vault/attachments?name=${encodeURIComponent(attachName)}`
      + (folder === undefined ? '' : `&folder=${encodeURIComponent(folder)}`),
      { method: 'POST', headers: { 'content-type': 'image/png' }, body: ATTACHMENT_PNG },
    );
    const uploadedPaths = [];
    const insideAttachments = (relativePath) => {
      if (typeof relativePath !== 'string' || !relativePath.startsWith('attachments/')) return false;
      if (relativePath.split('/').includes('..')) return false;
      const absolute = path.resolve(vaultDir, relativePath);
      return absolute.startsWith(path.resolve(vaultDir, 'attachments') + path.sep);
    };

    const groupedRes = await uploadAttachment('产物冒烟笔记/子目录').catch(() => null);
    const groupedBody = groupedRes?.ok ? await groupedRes.json().catch(() => null) : null;
    const groupedPath = groupedBody?.data?.path ?? '';
    uploadedPaths.push(groupedPath);
    check('附件按 folder 归组到 attachments/<笔记>/ 子目录（且真落盘）',
      groupedRes?.status === 201
      && groupedPath === `attachments/产物冒烟笔记/子目录/${attachName}`
      && fs.existsSync(path.resolve(vaultDir, groupedPath)),
      `status=${groupedRes?.status ?? 'ERR'} path=${groupedPath || '无'}`);

    const escapeFolders = [
      ['上跳', '../../越界目录'],
      ['绝对路径', 'C:\\Windows\\Temp'],
      ['超深嵌套', 'a/b/c/d/e/f/g'],
    ];
    const escapedFolders = [];
    const escapeResults = [];
    for (const [label, folder] of escapeFolders) {
      const res = await uploadAttachment(folder).catch(() => null);
      const body = res?.ok ? await res.json().catch(() => null) : null;
      const relativePath = body?.data?.path ?? '';
      escapeResults.push({ label, status: res?.status ?? 0, path: relativePath });
      uploadedPaths.push(relativePath);
      if (!(res?.status === 201 && insideAttachments(relativePath)
        && fs.existsSync(path.resolve(vaultDir, relativePath)))) {
        escapedFolders.push(`${label}→${res?.status ?? 'ERR'} path=${relativePath || '无'}`);
      }
    }
    check('附件 folder 被逐段清洗，逃不出 attachments/（上跳 / 绝对路径 / 超深嵌套）',
      escapedFolders.length === 0,
      escapedFolders.length ? `未被拦住：${escapedFolders.join(' | ')}` : `已验 ${escapeFolders.length} 类`);

    const deepFolderSegments = (escapeResults[2]?.path ?? '').split('/').slice(1, -1).length;
    check('附件 folder 深度上限 4 段（更深的被截断）',
      deepFolderSegments > 0 && deepFolderSegments <= 4,
      `路径=${escapeResults[2]?.path || '无'} 目录层数=${deepFolderSegments}`);

    for (const relativePath of uploadedPaths) {
      if (!relativePath) continue;
      await api(`/api/vault/attachments?path=${encodeURIComponent(relativePath)}`, { method: 'DELETE' }).catch(() => {});
    }

    // ---- frontmatter tags 并入标签系统（本轮新增 extractNoteTags） ----
    // 修复内容：frontmatter 的 tags（Obsidian 主流写法，支持 YAML 块列表）此前会被解析成空、
    // 且改写属性时可能丢失。现在 note 的完整标签集 = 正文内联标签 ∪ frontmatter tags。
    // 建一篇带 tags 属性的笔记，标签系统里必须能查到 —— 旧包里查不到。
    const tagName = `产物冒烟标签-${Date.now()}`;
    const taggedNote = await api('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: `产物冒烟标签笔记-${Date.now()}`,
        content: '标签冒烟',
        properties: { tags: [tagName] },
      }),
    });
    const taggedBody = taggedNote.ok ? await taggedNote.json() : null;
    const taggedId = taggedBody?.data?.id ?? taggedBody?.id;
    const tagsRes = await api('/api/tags');
    const tagsBody = tagsRes.ok ? await tagsRes.json() : null;
    const tagNames = (tagsBody?.data ?? []).map((tag) => tag?.name ?? tag);
    check('笔记 properties.tags 并入标签系统（GET /api/tags 能查到）',
      taggedNote.ok && tagNames.includes(tagName),
      `status=${taggedNote.status} 标签总数=${tagNames.length} 命中=${tagNames.includes(tagName)}`);
    if (taggedId) await api(`/api/notes/${taggedId}`, { method: 'DELETE' }).catch(() => {});

    check('Markdown 真落盘到 vault', fs.existsSync(vaultDir),
      `vault=${vaultDir} 存在=${fs.existsSync(vaultDir)}`);

    // ---- 文件助手 /api/files：入包 + 沙箱边界 + 确认门 + 可撤销 ----
    // 该模块的实现在仓库根 `scripts/fc-core.mjs`（server 侧是跨目录 import），所以它同时
    // 受两组判据保护：打包期 verify-package.cjs 与上面「相对 import 全部可达」拦「没进包」，
    // 这里验「进了包之后行为还对」。
    // ⚠️ 沙箱是这套能力的核心承诺：绝对路径、`..` 上跳、保留目录 `.fc` 都必须被拒。
    //    fc-core 里这三类都抛普通 Error → files.service 的 guarded() 包成 ValidationError
    //    → **HTTP 422**（不是 400、更不是 200）。断言「不是 200」之外再钉住 422。
    const fcEscapes = [
      ['上跳越界', '../../../../etc/passwd'],
      ['绝对路径(Windows)', 'C:\\Windows\\win.ini'],
      ['保留目录 .fc', '.fc/audit.jsonl'],
    ];
    const fcEscaped = [];
    for (const [label, badPath] of fcEscapes) {
      const res = await api(`/api/files/read?path=${encodeURIComponent(badPath)}`).catch(() => null);
      if (res?.status !== 422) fcEscaped.push(`${label}→${res?.status ?? 'ERR'}`);
    }
    check('文件助手拒绝越界路径（上跳 / 绝对路径 / 保留目录 .fc，均 422）',
      fcEscaped.length === 0,
      fcEscaped.length ? `未被拒：${fcEscaped.join(', ')}` : `已验 ${fcEscapes.length} 类`);

    // 确认门：写操作不带 confirmed 必须被拒（防「模型/界面直接落盘」）。
    const fcUnconfirmed = await api('/api/files/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'mkdir', path: `产物冒烟-未确认-${Date.now()}` }),
    }).catch(() => null);
    check('POST /api/files/execute 未带 confirmed 被拒（422）',
      fcUnconfirmed?.status === 422, `status=${fcUnconfirmed?.status ?? 'ERR'}`);

    // 完整链路：write → read 读回 → find 找到 → log 有审计 → undo 撤销后文件消失。
    const fcRelPath = `产物冒烟-fc-${Date.now()}.txt`;
    const fcPayload = `packaged smoke ${Date.now()}`;
    const fcAction = { type: 'write', path: fcRelPath, content: fcPayload };
    const fcPreview = await api('/api/files/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fcAction),
    }).catch(() => null);
    const fcPreviewBody = fcPreview?.ok ? await fcPreview.json().catch(() => null) : null;
    const fcPlanId = fcPreviewBody?.data?.plan?.id;
    const fcPlanHash = fcPreviewBody?.data?.planHash;
    check('POST /api/files/preview 返回执行计划和计划哈希',
      Boolean(fcPreview?.ok && fcPlanId && /^[a-f0-9]{64}$/i.test(fcPlanHash ?? '')),
      `status=${fcPreview?.status ?? 'ERR'} body=${JSON.stringify(fcPreviewBody)?.slice(0, 180)}`);

    const fcWrite = await api('/api/files/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...fcAction, confirmed: true, planId: fcPlanId, planHash: fcPlanHash }),
    }).catch(() => null);
    const fcWriteBody = fcWrite?.ok ? await fcWrite.json().catch(() => null) : null;
    check('POST /api/files/execute 带 confirmed 写入成功',
      Boolean(fcWrite?.ok && fcWriteBody?.data?.operationId),
      `status=${fcWrite?.status ?? 'ERR'} body=${JSON.stringify(fcWriteBody)?.slice(0, 140)}`);

    if (fcWrite?.ok) {
      const fcRead = await api(`/api/files/read?path=${encodeURIComponent(fcRelPath)}`).catch(() => null);
      const fcReadBody = fcRead?.ok ? await fcRead.json().catch(() => null) : null;
      check('GET /api/files/read 读回内容一致（与 /api/notes 共用同一 vault）',
        fcRead?.ok && fcReadBody?.data?.content === fcPayload,
        `status=${fcRead?.status ?? 'ERR'} content=${JSON.stringify(fcReadBody?.data?.content)?.slice(0, 60)}`);

      const fcFind = await api(`/api/files/find?pattern=${encodeURIComponent(fcRelPath)}`).catch(() => null);
      const fcFindBody = fcFind?.ok ? await fcFind.json().catch(() => null) : null;
      check('GET /api/files/find 能按模式找到刚写的文件',
        fcFind?.ok && (fcFindBody?.data?.items ?? []).some((item) => item.path === fcRelPath),
        `status=${fcFind?.status ?? 'ERR'} total=${fcFindBody?.data?.total}`);

      // grep 是本轮 fc-core 改造里新增的服务端端点（此前只有 CLI 侧能力），
      // 用它验证「正文检索」这条只读链路也随包可用。
      const fcGrep = await api(`/api/files/grep?query=${encodeURIComponent('packaged')}`).catch(() => null);
      const fcGrepBody = fcGrep?.ok ? await fcGrep.json().catch(() => null) : null;
      check('GET /api/files/grep 能按正文命中刚写的文件',
        fcGrep?.ok && (fcGrepBody?.data?.items ?? []).some((item) => item.path === fcRelPath),
        `status=${fcGrep?.status ?? 'ERR'} total=${fcGrepBody?.data?.total}`);

      const fcLog = await api('/api/files/log?limit=20').catch(() => null);
      const fcLogBody = fcLog?.ok ? await fcLog.json().catch(() => null) : null;
      check('GET /api/files/log 记下了这次操作（审计链随包可用）',
        fcLog?.ok && (fcLogBody?.data ?? []).some((entry) => entry.path === fcRelPath),
        `status=${fcLog?.status ?? 'ERR'} 条目=${Array.isArray(fcLogBody?.data) ? fcLogBody.data.length : 'n/a'}`);

      const fcUndo = await api('/api/files/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: fcWriteBody?.data?.operationId }),
      }).catch(() => null);
      const fcUndoBody = fcUndo?.ok ? await fcUndo.json().catch(() => null) : null;
      check('POST /api/files/undo 撤销成功且文件已不在 vault（同时完成清理）',
        Boolean(fcUndo?.ok && fcUndoBody?.data?.undone === true) && !fs.existsSync(path.join(vaultDir, fcRelPath)),
        `status=${fcUndo?.status ?? 'ERR'} body=${JSON.stringify(fcUndoBody)?.slice(0, 140)}`);
    }

    // ---- Vault profile（PUT /api/vault/profile，2026-10-03 新增）----
    // profile 决定 Inbox / Daily / Journal 的落盘目录，持久化在 <vault>/.lattice/profile.json。
    // 这类「可配置目录」接口最容易出的两类错：① 读得到但写不进（HTTP 200、盘上没变）；
    // ② 非法值没拦住（绝对路径 / . / .. / 隐藏目录 / _templates），让内容写到 Vault 之外
    //   或内部目录里。所以既验「正路 + 真落盘」，也验各类越界一律 422。
    // ⚠️ 放在最后跑：它会改写 profile，而 Inbox/Daily 的落盘目录受其影响，插在前面会干扰
    //    上面那条 inboxStatus 相关的断言。
    const vaultInfo = await api('/api/vault/info').catch(() => null);
    const vaultInfoBody = vaultInfo?.ok ? await vaultInfo.json().catch(() => null) : null;
    check('GET /api/vault/info 下发 vault profile（含 inbox/daily/journal）',
      Boolean(vaultInfoBody?.data?.profile?.paths?.inbox),
      `status=${vaultInfo?.status ?? 'ERR'} profile=${JSON.stringify(vaultInfoBody?.data?.profile)?.slice(0, 120)}`);

    const profileTarget = { inbox: 'Work/Inbox', daily: 'Work/Daily', journal: 'Work/Journal' };
    const profilePut = await api('/api/vault/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: profileTarget }),
    }).catch(() => null);
    const profilePutBody = profilePut?.ok ? await profilePut.json().catch(() => null) : null;
    const profileDisk = path.join(vaultDir, '.lattice', 'profile.json');
    let profileOnDisk = null;
    try { profileOnDisk = JSON.parse(fs.readFileSync(profileDisk, 'utf8')); } catch { profileOnDisk = null; }
    check('PUT /api/vault/profile 接受合法 profile、回读一致且真落盘到 .lattice/profile.json',
      Boolean(profilePut?.ok
        && profilePutBody?.data?.profile?.paths?.inbox === profileTarget.inbox
        && profileOnDisk?.paths?.inbox === profileTarget.inbox),
      `status=${profilePut?.status ?? 'ERR'} 响应=${profilePutBody?.data?.profile?.paths?.inbox ?? 'n/a'} 盘上=${profileOnDisk?.paths?.inbox ?? 'n/a'}`);

    const badProfiles = [
      ['绝对路径', 'C:\\Inbox'],
      ['上跳', '../outside'],
      ['隐藏目录', '.secret'],
      ['内部目录 _templates', '_templates'],
    ];
    const profileEscaped = [];
    for (const [label, inbox] of badProfiles) {
      const res = await api('/api/vault/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: { inbox, daily: 'Daily', journal: 'Journal' } }),
      }).catch(() => null);
      if (res?.status !== 422) profileEscaped.push(`${label}→${res?.status ?? 'ERR'}`);
    }
    check('PUT /api/vault/profile 拒绝越界 profile（绝对路径/上跳/隐藏/内部目录，均 422）',
      profileEscaped.length === 0,
      profileEscaped.length ? `未被拒：${profileEscaped.join(', ')}` : `已验 ${badProfiles.length} 类`);
  } finally {
    try { stop(); } catch { /* 已关闭 */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄未释放 */ }
  }

  console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`产物冒烟失败：${error.stack ?? error.message}`);
  process.exit(1);
});
