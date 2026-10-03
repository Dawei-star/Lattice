'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyPackage } = require('../build/verify-package.cjs');

function makePackage({ route = true, client = true, pwa = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-package-'));
  const routeDir = path.join(root, 'server', 'src', 'modules', 'canvas');
  const assetsDir = path.join(root, 'web', 'assets');
  fs.mkdirSync(routeDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(routeDir, 'canvas.routes.js'), route ? "canvasRouter.get('/files', controller.listCanvasFiles);" : 'canvasRouter.get(\'/\', controller.readCanvas);');
  fs.writeFileSync(path.join(routeDir, 'canvas.controller.js'), 'export function listCanvasFiles() {}');
  fs.writeFileSync(path.join(assetsDir, 'index.js'), client ? 'fetch("/canvas/files");' : 'fetch("/canvas");');
  // verifyPackage 还要求 PWA 静态资源随包发出（web/public 会被 vite 拷进 web/dist 根）。
  if (pwa) {
    fs.writeFileSync(path.join(root, 'web', 'sw.js'), 'self.addEventListener("install", () => {});');
    fs.writeFileSync(path.join(root, 'web', 'manifest.webmanifest'), '{"name":"Lattice"}');
  }
  fs.writeFileSync(
    path.join(root, 'web', 'index.html'),
    pwa ? '<link rel="manifest" href="/manifest.webmanifest" /><div id="root"></div>' : '<div id="root"></div>',
  );
  return root;
}

test('package contract accepts matching canvas client and server artifacts', (t) => {
  const root = makePackage();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.doesNotThrow(() => verifyPackage(root));
});

test('package contract rejects an artifact with the canvas list route missing', (t) => {
  const root = makePackage({ route: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /does not provide GET \/api\/canvas\/files/);
});

test('package contract rejects an artifact with the canvas client missing', (t) => {
  const root = makePackage({ client: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /does not include the canvas file-list API contract/);
});

test('package contract rejects an artifact with PWA assets missing', (t) => {
  const root = makePackage({ pwa: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /missing PWA assets/);
});
