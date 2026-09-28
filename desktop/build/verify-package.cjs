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
}

module.exports = async function verifyAfterPack(context) {
  verifyPackage(path.join(context.appOutDir, 'resources', 'app'));
};

module.exports.verifyPackage = verifyPackage;
