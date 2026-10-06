'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CANVAS_ENDPOINT = '/canvas/files';
const CANVAS_ROUTE = "canvasRouter.get('/files', controller.listCanvasFiles)";

function readFile(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing packaged file: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function findJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) throw new Error(`Missing packaged assets directory: ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(directory, entry.name));
}

/** 递归列出 .js，跳过 node_modules 与开发态 .mimosa（本就不会进包）。 */
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

/** 去掉块注释与行注释，避免注释里提到的路径被误判成 import 说明符。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const RELATIVE_IMPORT_RE = /(?:from\s*|import\s*\(\s*)['"](\.[^'"]*)['"]/g;

/**
 * 包内**每一条相对 import 都必须能在包内解析到真实文件**。
 *
 * 立这条判据的起因（2026-10-02 实测）：「确定性文件助手」把 `fc-core.mjs` 放在仓库根
 * `scripts/`，而 `server/src/modules/files/files.service.js` 与
 * `server/src/modules/ai/ai.operations.js` 都写死 `'../../../../scripts/fc-core.mjs'`。
 * 打包只拷 `../server/src`，包内没有 `scripts/` → 这两条 ESM 静态 import 直接抛
 * ERR_MODULE_NOT_FOUND → **整个后端启动即崩**（前端白屏），而不是某个接口 404。
 * 单看源码目录一切正常、单看单个模块测试也全绿，只有「按包内布局重算相对路径」才暴露。
 */
function verifyRelativeImports(appRoot) {
  const roots = [path.join(appRoot, 'src'), path.join(appRoot, 'server', 'src')];
  const unresolved = [];
  for (const file of roots.flatMap(walkJavaScriptFiles)) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
      const specifier = match[1];
      if (!fs.existsSync(path.resolve(path.dirname(file), specifier))) {
        unresolved.push(`${path.relative(appRoot, file).replaceAll('\\', '/')} → ${specifier}`);
      }
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      'Packaged app has unresolvable relative imports. A source file reaches outside the copied '
      + 'directories (e.g. server/src → <repo>/scripts); add it to electron-builder.yml "files":\n  '
      + unresolved.join('\n  '),
    );
  }
}

/**
 * PWA 静态资源必须随包发出。
 *
 * `web/public/` 下的 manifest.webmanifest 与 sw.js 由 vite **原样拷**进 web/dist 根目录，
 * index.html 用 <link rel="manifest" href="/manifest.webmanifest"> 引用。它们不像 assets/
 * 那样有 hash 与体积校验，漏发后页面完全正常，只有「安装为应用」「离线壳缓存」静默失效；
 * service worker 还必须在站点根才能拿到覆盖全站的 scope。所以在打包期直接拦下，别等冒烟。
 */
const PWA_ASSETS = ['sw.js', 'manifest.webmanifest'];

function verifyPwaAssets(appRoot) {
  const webDir = path.join(appRoot, 'web');
  const missing = PWA_ASSETS.filter((name) => !fs.existsSync(path.join(webDir, name)));
  if (missing.length > 0) {
    throw new Error(
      `Packaged web/ is missing PWA assets: ${missing.join(', ')}. `
      + 'web/public must be built into web/dist before packaging.',
    );
  }
  const indexFile = path.join(webDir, 'index.html');
  if (!fs.existsSync(indexFile) || !readFile(indexFile).includes('manifest.webmanifest')) {
    throw new Error('Packaged web/index.html does not reference manifest.webmanifest.');
  }
}

/**
 * MCP 插件市场的品牌 logo 必须随包发出。
 *
 * 设置页的市场卡片用 `/mcp-logos/<name>.svg` 引用品牌图标，这些 svg 由 vite 从
 * `web/public/mcp-logos/` 原样拷进 web/dist 根下的 `mcp-logos/`。它们不在 assets/ 里、
 * 没有 hash 与体积校验，漏打包时后端与页面都正常，只有卡片图标静默裂图。
 *
 * ⚠️ 包内 bundle 里 logo 路径是**模板拼出来的**（`LOGO = (n) => \`/mcp-logos/${n}.svg\``），
 * 并不含 `/mcp-logos/brave.svg` 这样的完整字面量，所以这里只能核实「该目录被引用过、且确实
 * 带进来了一批非空 svg」；逐个 logo 与源码目录被引用集合的精确比对交给 packaged-smoke
 * （它读源码里的 LOGO(...) 调用点）。两道判据合起来才闭环 —— 曾因在这条判据上写
 * `/mcp-logos/[a-z0-9-]+\.svg` 的字面量正则，导致打包在 afterPack 阶段被自己的护栏拦下。
 */
const MARKET_ID_PREFIX = 'mcp-market-';
const MARKET_LOGO_DIR = 'mcp-logos';

function verifyMarketplaceAssets(appRoot) {
  const webDir = path.join(appRoot, 'web');
  const bundles = findJavaScriptFiles(path.join(webDir, 'assets'));
  if (bundles.length === 0) throw new Error('Packaged web/assets has no JavaScript bundles.');
  const bundleText = bundles.map(readFile).join('\n');
  if (!bundleText.includes(MARKET_ID_PREFIX) || !bundleText.includes(`/${MARKET_LOGO_DIR}/`)) {
    throw new Error(
      'Packaged frontend does not include the MCP marketplace '
      + `(missing "${MARKET_ID_PREFIX}" / "/${MARKET_LOGO_DIR}/"). Rebuild web/dist before packaging.`,
    );
  }
  const logoDir = path.join(webDir, MARKET_LOGO_DIR);
  const logos = fs.existsSync(logoDir)
    ? fs.readdirSync(logoDir).filter((name) => name.endsWith('.svg')).sort()
    : [];
  if (logos.length === 0) {
    throw new Error(
      `Packaged web/${MARKET_LOGO_DIR} has no .svg logos; marketplace cards would render broken images. `
      + 'web/public/mcp-logos must be built into web/dist before packaging.',
    );
  }
  const empty = logos.filter((name) => fs.statSync(path.join(logoDir, name)).size === 0);
  if (empty.length > 0) {
    throw new Error(`Packaged marketplace logos are empty files: ${empty.join(', ')}.`);
  }
}

/**
 * 内置 MCP Server 必须随包发出，且自带依赖。
 *
 * 设置页「导出配置」里的 Lattice 条目指向包内 `scripts/mcp-server/server.mjs`
 * （/api/mcp/info 的 serverPath 按包内层级解析）。漏打它不会崩任何进程——
 * 后端与页面一切正常，只有外部客户端拉起配置时报「文件不存在」，属于最阴的静默失效。
 * server.mjs 的裸导入（@modelcontextprotocol/sdk / zod）由本目录自带 node_modules 解析，
 * 少了依赖会在外部客户端连接时立刻失败，所以一并核验。
 */
function verifyMcpServerPackaged(appRoot) {
  const serverFile = path.join(appRoot, 'scripts', 'mcp-server', 'server.mjs');
  if (!fs.existsSync(serverFile)) {
    throw new Error(
      'Packaged app is missing scripts/mcp-server/server.mjs. The exported Lattice MCP config '
      + 'points at this file; without it external clients cannot start the server. '
      + 'Add it to electron-builder.yml "files".',
    );
  }
  const sdkDir = path.join(appRoot, 'scripts', 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk');
  if (!fs.existsSync(path.join(sdkDir, 'package.json'))) {
    throw new Error(
      'Packaged scripts/mcp-server is missing its node_modules (@modelcontextprotocol/sdk). '
      + 'Run npm install in scripts/mcp-server before packaging.',
    );
  }
}

/**
 * 服务端 `ai.mcp.js` 的裸导入 `@modelcontextprotocol/sdk` 必须在包内可解析。
 *
 * 与上一条是**两个不同的副本**：`scripts/mcp-server/` 自带一份（供外部客户端拉起内置
 * MCP Server 用），而 `server/src/modules/ai/ai.mcp.js` 用的是 app 根
 * `resources/app/node_modules` 那一份（由 electron-builder 按 desktop/package.json 的
 * dependencies 装出来）。它是在**模块加载期**被静态 import 的，缺了就是整个后端启动即崩
 * （前端白屏），而不是某个 AI 接口 404。desktop/package.json 与 server/package.json
 * 都要声明这个依赖，漏一边都会让其中一条链路炸。
 */
function verifyAiMcpSdkPackaged(appRoot) {
  const sdkManifest = path.join(appRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
  if (!fs.existsSync(sdkManifest)) {
    throw new Error(
      'Packaged app/node_modules is missing @modelcontextprotocol/sdk, which '
      + 'server/src/modules/ai/ai.mcp.js imports at module load — the whole backend would fail to start. '
      + 'Declare it in desktop/package.json "dependencies" and reinstall before packaging.',
    );
  }
}

/**
 * 「AI 会话按专家隔离」这条链路的三段都必须在包里。
 *
 * 会话列表按 `expert_id = ?` 过滤、创建会话时写入 `expert_id`，列出的元数据是
 * `{total, limit, offset, hasMore}` 而不是一个裸数组。这三样任何一段回退，
 * 接口都照样 200：用户只是「切了专家还看到上一个专家的对话」，或历史面板不再分页。
 * 而 ① 依赖迁移 007 建出的 `ai_sessions.expert_id` 列，缺列时整片 500；
 * ② 依赖 `listSessionPage` 这个导出被 controller 真正调用。两者都不会主动报错。
 */
function verifyAiSessionExpertRouting(appRoot) {
  const aiDir = path.join(appRoot, 'server', 'src', 'modules', 'ai');
  const sessionsFile = path.join(aiDir, 'ai.sessions.js');
  const controllerFile = path.join(aiDir, 'ai.controller.js');

  // ① 迁移 007 必须随包，且真的 ALTER 了 ai_sessions。
  const migration = path.join(appRoot, 'server', 'src', 'migrations', '007_ai_session_expert.sql');
  if (!fs.existsSync(migration)) {
    throw new Error(
      'Packaged server/src/migrations/007_ai_session_expert.sql is missing. AI sessions are filtered by '
      + 'expert_id; without the column the session list query throws at runtime.',
    );
  }
  if (!stripComments(readFile(migration)).includes('expert_id')) {
    throw new Error('Packaged 007_ai_session_expert.sql no longer adds the expert_id column.');
  }

  // ② 分页实现要以**导出**形态存在，且真的按专家过滤（WHERE 带 expert_id = ?）。
  // 只查名字会被「去掉 export 关键字」骗过 —— 名字还在，但 controller 的具名 import 已经不成立。
  const sessions = stripComments(readFile(sessionsFile));
  if (!/export\s+(?:async\s+)?function\s+listSessionPage\b/.test(sessions)) {
    throw new Error('Packaged ai.sessions.js no longer exports listSessionPage; /api/ai/sessions pagination is gone.');
  }
  if (!/expert_id\s*=\s*\?/.test(sessions)) {
    throw new Error(
      'Packaged ai.sessions.js no longer filters sessions by expert_id. Sessions from other experts '
      + 'would leak into every list.',
    );
  }

  // ③ controller 必须走分页实现并回 meta，否则前端拿到裸数组就当全部数据。
  const controller = stripComments(readFile(controllerFile));
  if (!/sessions\.listSessionPage\(/.test(controller)) {
    throw new Error('Packaged ai.controller.js no longer calls sessions.listSessionPage for GET /api/ai/sessions.');
  }
  if (!/hasMore/.test(controller)) {
    throw new Error('Packaged ai.controller.js no longer returns the pagination meta (total/limit/offset/hasMore).');
  }
}

/**
 * 内置专家 / Skill 资源必须随包发出。
 *
 * `server/src/modules/experts/builtin/` 下是**运行时数据**：6 个 expert `.json` +
 * 7 个 skill 目录（每个必须同时有 `SKILL.md` 与 `skill.json`）。`experts.registry.js` 用
 * `path.join(MODULE_DIR, 'builtin')` 读取，而 `listExperts()` / `listSkills()` 把读取异常
 * **静默吞掉** —— 少一个文件不会报错，只会「专家中心里少了个专家」或某个 skill 的
 * `available` 变成 false。所以这里同时核三件事：目录非空、每个 skill 目录文件成对、
 * 每条 expert 绑定的 skill 都能在包内找到（id 必须等于目录名）。
 */
function verifyBuiltinExperts(appRoot) {
  const builtinDir = path.join(appRoot, 'server', 'src', 'modules', 'experts', 'builtin');
  const expertsDir = path.join(builtinDir, 'experts');
  const skillsDir = path.join(builtinDir, 'skills');
  const expertFiles = fs.existsSync(expertsDir)
    ? fs.readdirSync(expertsDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  if (expertFiles.length === 0) {
    throw new Error(
      'Packaged server/src/modules/experts/builtin/experts has no expert definitions; '
      + 'the experts center would render empty with no error. server/src must be copied wholesale.',
    );
  }
  const skillDirs = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : [];
  const broken = [];
  for (const name of skillDirs) {
    for (const required of ['SKILL.md', 'skill.json']) {
      if (!fs.existsSync(path.join(skillsDir, name, required))) broken.push(`${name}/${required}`);
    }
  }
  if (broken.length > 0) {
    throw new Error(
      `Packaged builtin skills are incomplete: ${broken.join(', ')}. `
      + 'readSkillFromDir requires BOTH files, otherwise the whole directory is skipped silently.',
    );
  }
  const missingBindings = [];
  for (const file of expertFiles) {
    let parsed;
    try {
      parsed = JSON.parse(readFile(path.join(expertsDir, file)));
    } catch {
      continue;
    }
    for (const binding of parsed?.skills ?? []) {
      const id = typeof binding === 'string' ? binding : binding?.id;
      if (typeof id !== 'string' || !id) continue;
      if (!fs.existsSync(path.join(skillsDir, id, 'SKILL.md'))) {
        missingBindings.push(`${path.basename(file, '.json')} → ${id}`);
      }
    }
  }
  if (missingBindings.length > 0) {
    throw new Error(
      `Builtin experts bind skills that are not packaged: ${missingBindings.join(', ')}. `
      + 'A skill directory name must equal its id, and both files must be present.',
    );
  }
}

/**
 * 「知识健康中心」（review 模块）必须随包发出，且其 6 个分类键都在。
 *
 * 前端 KnowledgeHealthCenter 按**固定 key** 渲染 6 张卡片（inbox / brokenLinks /
 * isolated / stale / duplicates / incomplete）。服务端少导出一个分类不会报错，
 * 页面只是静默少一块面板 —— 属于典型的「漏了不报错」故障，故在打包期就钉住：
 * ① 三个源文件齐全；② 六个分类键都出现在 `categories` 的构造里。
 *
 * ⚠️ 判据要同时认两种合法写法，因为真实源码用的是 ES6 简写
 * `const categories = { inbox, brokenLinks, ... }`（没有 `inbox:` 这种字面量）：
 *     { inbox: a, brokenLinks: b }      → `<key>:`
 *     { inbox, brokenLinks }            → `<key>` 出现在 `{` 与 `}` 之间
 * 早期版本只认前者，直接把正常包判成不合格（2026-10-06 打包被 afterPack 拦下）。
 */
const HEALTH_CATEGORY_KEYS = ['inbox', 'brokenLinks', 'isolated', 'stale', 'duplicates', 'incomplete'];

function verifyReviewModule(appRoot) {
  const reviewDir = path.join(appRoot, 'server', 'src', 'modules', 'review');
  const required = ['review.routes.js', 'review.controller.js', 'knowledge-health.service.js'];
  const missing = required.filter((name) => !fs.existsSync(path.join(reviewDir, name)));
  if (missing.length > 0) {
    throw new Error(
      `Packaged server/src/modules/review is missing: ${missing.join(', ')}. `
      + 'server/src must be copied wholesale.',
    );
  }
  const service = stripComments(readFile(path.join(reviewDir, 'knowledge-health.service.js')));
  // 只在 `categories` 的构造位置找键，避免文件里其它同名字符串造成误判。
  // 匹配**完整字面量**（含首尾大括号）：若只取 `{` 与 `}` 之间的片段，最后一个键
  // 后面就没有终止符可对齐（`[^}]*` 的老坑），`incomplete` 会被误判成缺失。
  const literal = /categories\s*=\s*\{[^}]*\}/.exec(service);
  const absent = literal
    ? HEALTH_CATEGORY_KEYS.filter((key) => !new RegExp(`(^|[{,\\s])${key}\\s*[,:}]`).test(literal[0]))
    : HEALTH_CATEGORY_KEYS;
  if (absent.length > 0) {
    throw new Error(
      `Packaged knowledge-health service no longer builds these categories: ${absent.join(', ')}. `
      + 'The frontend renders one card per key and silently omits a card when the key is gone.',
    );
  }
}

function verifyPackage(appRoot) {
  const routeFile = path.join(appRoot, 'server', 'src', 'modules', 'canvas', 'canvas.routes.js');
  const controllerFile = path.join(appRoot, 'server', 'src', 'modules', 'canvas', 'canvas.controller.js');
  const routeSource = readFile(routeFile);
  const controllerSource = readFile(controllerFile);
  const clientBundles = findJavaScriptFiles(path.join(appRoot, 'web', 'assets'));

  if (!routeSource.includes(CANVAS_ROUTE) || !controllerSource.includes('listCanvasFiles')) {
    throw new Error('Packaged backend does not provide GET /api/canvas/files. Rebuild from matching server sources.');
  }
  if (!clientBundles.some((bundle) => readFile(bundle).includes(CANVAS_ENDPOINT))) {
    throw new Error('Packaged frontend does not include the canvas file-list API contract. Rebuild web/dist before packaging.');
  }

  verifyRelativeImports(appRoot);
  verifyPwaAssets(appRoot);
  verifyMarketplaceAssets(appRoot);
  verifyMcpServerPackaged(appRoot);
  verifyAiMcpSdkPackaged(appRoot);
  verifyBuiltinExperts(appRoot);
  verifyReviewModule(appRoot);
  verifyAiSessionExpertRouting(appRoot);
}

module.exports = async function verifyAfterPack(context) {
  verifyPackage(path.join(context.appOutDir, 'resources', 'app'));
};

module.exports.verifyPackage = verifyPackage;
module.exports.verifyRelativeImports = verifyRelativeImports;
module.exports.verifyPwaAssets = verifyPwaAssets;
module.exports.verifyMarketplaceAssets = verifyMarketplaceAssets;
module.exports.verifyMcpServerPackaged = verifyMcpServerPackaged;
module.exports.verifyAiMcpSdkPackaged = verifyAiMcpSdkPackaged;
module.exports.verifyBuiltinExperts = verifyBuiltinExperts;
module.exports.verifyReviewModule = verifyReviewModule;
module.exports.verifyAiSessionExpertRouting = verifyAiSessionExpertRouting;
