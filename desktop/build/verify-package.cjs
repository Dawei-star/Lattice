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
}

module.exports = async function verifyAfterPack(context) {
  verifyPackage(path.join(context.appOutDir, 'resources', 'app'));
};

module.exports.verifyPackage = verifyPackage;
module.exports.verifyRelativeImports = verifyRelativeImports;
