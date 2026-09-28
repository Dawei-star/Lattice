import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { installDom, waitFor } from './dom-setup.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.LATTICE_BASE_URL ?? 'http://127.0.0.1:5177';

await esbuild.build({
  entryPoints: [path.join(testDir, 'app-entry.jsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  outfile: path.join(testDir, '.build', 'canvas-navigation-app.mjs'),
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'warning',
});

const { window } = installDom(baseUrl);
const { mount } = await import(pathToFileURL(path.join(testDir, '.build', 'canvas-navigation-app.mjs')).href);
const { container } = mount();

await waitFor(
  () => container.querySelector('.tree__canvas-file') && container.querySelector('.tree__note'),
  { label: 'canvas file and note file' },
);

container.querySelector('.tree__canvas-file').click();
await waitFor(() => container.querySelector('.canvas-view'), { label: 'canvas view' });

container.querySelector('.tree__note').click();
await new Promise((resolve) => window.setTimeout(resolve, 250));

if (container.querySelector('.canvas-view')) {
  throw new Error('clicking a note after opening a canvas leaves the app in canvas view');
}

if (!container.querySelector('.editor__title')) {
  throw new Error('clicking a note after opening a canvas did not open the note editor');
}

console.log('canvas navigation regression passed');
