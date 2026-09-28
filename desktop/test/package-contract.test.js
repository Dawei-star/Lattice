'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyPackage } = require('../build/verify-package.cjs');

function makePackage({ route = true, client = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-package-'));
  const routeDir = path.join(root, 'server', 'src', 'modules', 'canvas');
  const assetsDir = path.join(root, 'web', 'assets');
  fs.mkdirSync(routeDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(routeDir, 'canvas.routes.js'), route ? "canvasRouter.get('/files', controller.listCanvasFiles);" : 'canvasRouter.get(\'/\', controller.readCanvas);');
  fs.writeFileSync(path.join(routeDir, 'canvas.controller.js'), 'export function listCanvasFiles() {}');
  fs.writeFileSync(path.join(assetsDir, 'index.js'), client ? 'fetch("/canvas/files");' : 'fetch("/canvas");');
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
