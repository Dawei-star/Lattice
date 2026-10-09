import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { installDom, waitFor } from './dom-setup.mjs';
import { testDefine } from './build-define.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.LATTICE_BASE_URL ?? 'http://127.0.0.1:5177';

const folderResponse = await fetch(`${baseUrl}/api/folders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: `画布导航回归-${Date.now()}`, confirmed: true }),
});
const folderPayload = await folderResponse.json();
const seededFolderId = folderPayload?.data?.id;
if (!folderResponse.ok || !seededFolderId) {
  throw new Error(`无法准备画布导航测试目录（HTTP ${folderResponse.status}）`);
}

const seeded = await fetch(`${baseUrl}/api/notes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: `画布导航回归-${Date.now()}`,
    content: '画布导航回归测试的临时笔记。',
    folderId: seededFolderId,
    confirmed: true,
  }),
});
const seededPayload = await seeded.json();
const seededNoteId = seededPayload?.data?.id;
if (!seeded.ok || !seededNoteId) {
  throw new Error(`无法准备画布导航测试数据（HTTP ${seeded.status}）`);
}

await esbuild.build({
  entryPoints: [path.join(testDir, 'app-entry.jsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  outfile: path.join(testDir, '.build', 'canvas-navigation-app.mjs'),
  define: testDefine('development'),
  logLevel: 'warning',
});

const { window } = installDom(baseUrl);
const { mount } = await import(pathToFileURL(path.join(testDir, '.build', 'canvas-navigation-app.mjs')).href);
const { container, root } = mount();

try {
  await waitFor(
  () => container.querySelector('.tree__canvas-file') && container.querySelector('.tree__note:not(.tree__canvas-file)'),
    { label: 'canvas file and note file' },
  );

  container.querySelector('.tree__canvas-file').click();
  await waitFor(() => container.querySelector('.canvas-view'), { label: 'canvas view' });

  container.querySelector('.tree__note:not(.tree__canvas-file)').click();
  await new Promise((resolve) => window.setTimeout(resolve, 250));

  if (container.querySelector('.canvas-view')) {
    throw new Error('clicking a note after opening a canvas leaves the app in canvas view');
  }

  if (!container.querySelector('.editor__title')) {
    throw new Error('clicking a note after opening a canvas did not open the note editor');
  }

  console.log('canvas navigation regression passed');
} finally {
  root.unmount();
  await fetch(`${baseUrl}/api/notes/${seededNoteId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true, secondConfirmed: true }),
  });
  await fetch(`${baseUrl}/api/folders/${seededFolderId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true, secondConfirmed: true }),
  });
}
