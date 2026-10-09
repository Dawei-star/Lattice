/**
 * 画布平移回归测试。
 *
 * 背景：左键在空白画布拖拽曾是框选，平移只留空格 / 中键 / 触控板，
 * 而舞台光标却是抓手，普通鼠标用户无法移动画布。回归约定：
 * 1) 左键空白拖拽必须平移视图（--canvas-x/--canvas-y 跟随位移）；
 * 2) 平移过程不得出现框选框；
 * 3) Shift + 左键拖拽仍是框选。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { installDom, waitFor } from './dom-setup.mjs';
import { testDefine } from './build-define.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.LATTICE_BASE_URL ?? 'http://127.0.0.1:5177';

const CANVAS_NAME = `平移回归-${Date.now()}.canvas`;

const createResponse = await fetch(`${baseUrl}/api/canvas?path=${encodeURIComponent(CANVAS_NAME)}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nodes: [
      { id: 'n1', type: 'text', text: '甲', x: 100, y: 100 },
      { id: 'n2', type: 'text', text: '乙', x: 500, y: 320 },
    ],
    edges: [],
    confirmed: true,
  }),
});
if (!createResponse.ok) throw new Error(`无法准备测试画布（HTTP ${createResponse.status}）`);

await esbuild.build({
  entryPoints: [path.join(testDir, 'app-entry.jsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  outfile: path.join(testDir, '.build', 'canvas-pan-app.mjs'),
  define: testDefine('development'),
  logLevel: 'warning',
});

const { window } = installDom(baseUrl);

const { mount } = await import(pathToFileURL(path.join(testDir, '.build', 'canvas-pan-app.mjs')).href);
const { container, root } = mount();

const pointer = (type, target, init = {}) => target.dispatchEvent(new window.MouseEvent(type, {
  bubbles: true,
  cancelable: true,
  button: 0,
  ...init,
}));

const viewOffset = (stage) => ({
  x: Number.parseFloat(stage.style.getPropertyValue('--canvas-x')) || 0,
  y: Number.parseFloat(stage.style.getPropertyValue('--canvas-y')) || 0,
});

try {
  await waitFor(() => [...container.querySelectorAll('.tree__canvas-file')]
    .some((node) => node.textContent.includes(CANVAS_NAME.replace('.canvas', ''))), { label: 'canvas tree entry' });
  [...container.querySelectorAll('.tree__canvas-file')]
    .find((node) => node.textContent.includes(CANVAS_NAME.replace('.canvas', '')))
    .click();
  await waitFor(() => container.querySelector('.canvas-stage'), { label: 'canvas stage' });
  // 等待自动适配（fitView 0.22s 补间）结束，避免补间帧污染位移基线
  await new Promise((resolve) => window.setTimeout(resolve, 500));

  const stage = container.querySelector('.canvas-stage');

  // 1) 左键空白拖拽 → 平移；期间不出现框选框
  pointer('pointerdown', stage, { clientX: 300, clientY: 300 });
  const before = viewOffset(stage);
  pointer('pointermove', stage, { clientX: 420, clientY: 260 });
  if (container.querySelector('.canvas-marquee')) {
    throw new Error('左键空白拖拽平移时不应出现框选框');
  }
  pointer('pointerup', stage, { clientX: 420, clientY: 260 });
  const after = viewOffset(stage);
  if (Math.abs(after.x - before.x - 120) > 1 || Math.abs(after.y - before.y + 40) > 1) {
    throw new Error(`左键拖拽未平移画布：dx=${after.x - before.x} dy=${after.y - before.y}`);
  }

  // 2) Shift + 左键拖拽 → 框选
  pointer('pointerdown', stage, { clientX: 200, clientY: 200, shiftKey: true });
  pointer('pointermove', stage, { clientX: 420, clientY: 380, shiftKey: true });
  await waitFor(() => container.querySelector('.canvas-marquee'), { label: 'shift marquee' });
  pointer('pointerup', stage, { clientX: 420, clientY: 380, shiftKey: true });
  await waitFor(() => !container.querySelector('.canvas-marquee'), { label: 'marquee cleared' });

  console.log('canvas pan regression passed');
} finally {
  root.unmount();
  await fetch(`${baseUrl}/api/canvas/file?path=${encodeURIComponent(CANVAS_NAME)}&confirmed=true&secondConfirmed=true`, { method: 'DELETE' }).catch(() => {});
}
