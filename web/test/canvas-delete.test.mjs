/**
 * 画布右键菜单「删除画布 / 在系统资源管理器中显示」回归测试。
 *
 * 背景：Sidebar 曾漏转发 onDeleteCanvas / onRevealCanvas / onOpenCanvasDefault，
 * 菜单点击后静默无反应。这里挂载真实 App + 真实后端，走完整菜单交互链路。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { installDom, waitFor } from './dom-setup.mjs';
import { testDefine } from './build-define.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.LATTICE_BASE_URL ?? 'http://127.0.0.1:5177';

const CANVAS_NAME = `删除回归-${Date.now()}.canvas`;

// 准备一个真实存在于 Vault 的画布文件
const createResponse = await fetch(`${baseUrl}/api/canvas?path=${encodeURIComponent(CANVAS_NAME)}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nodes: [], edges: [], confirmed: true }),
});
if (!createResponse.ok) throw new Error(`无法准备测试画布（HTTP ${createResponse.status}）`);

await esbuild.build({
  entryPoints: [path.join(testDir, 'app-entry.jsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  outfile: path.join(testDir, '.build', 'canvas-delete-app.mjs'),
  define: testDefine('development'),
  logLevel: 'warning',
});

const { window } = installDom(baseUrl);
// jsdom 默认 confirm 返回 falsy，这里替用户点「确定」
window.confirm = () => true;

const { mount } = await import(pathToFileURL(path.join(testDir, '.build', 'canvas-delete-app.mjs')).href);
const { container, root } = mount();

const menuLabel = (label) => [...document.querySelectorAll('.menu__label')].find((node) => node.textContent === label);
const canvasItem = () => [...container.querySelectorAll('.tree__canvas-file')].find((node) => node.textContent.includes(CANVAS_NAME.replace('.canvas', '')));

const openCanvasMenu = async () => {
  const item = canvasItem();
  if (!item) throw new Error('画布未出现在目录树中');
  item.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await waitFor(() => menuLabel('删除画布'), { label: 'canvas context menu' });
};

try {
  await waitFor(() => canvasItem(), { label: 'canvas tree entry' });

  // 1)「在系统资源管理器中显示」必须真的触达处理器（浏览器模式给出明确提示，而不是静默无反应）
  await openCanvasMenu();
  menuLabel('在系统资源管理器中显示').closest('[role="menuitem"]').click();
  await waitFor(() => document.querySelector('.toast-host')?.textContent?.includes('资源管理器'), {
    label: 'reveal toast (browser mode info)',
  });

  // 2)「删除画布」必须真的删除文件并把条目从目录树移除
  await waitFor(() => !document.querySelector('.toast-host')?.textContent?.includes('资源管理器') || true, { label: 'settle' });
  await openCanvasMenu();
  menuLabel('删除画布').closest('[role="menuitem"]').click();
  await waitFor(() => document.querySelector('.file-confirmation-card'), { label: 'canvas delete confirmation card' });
  document.querySelector('.file-confirmation-card button.btn--danger')?.click();
  await waitFor(() => document.querySelector('.file-confirmation-card h2')?.textContent?.includes('删除不可逆'), { label: 'canvas delete second confirmation' });
  document.querySelector('.file-confirmation-card button.btn--danger')?.click();
  await waitFor(() => !canvasItem(), { label: 'canvas entry removed from tree' });

  const filesResponse = await fetch(`${baseUrl}/api/canvas/files`);
  const filesPayload = await filesResponse.json();
  if ((filesPayload?.data ?? []).some((file) => file.path === CANVAS_NAME)) {
    throw new Error('删除后后端画布列表仍包含该文件');
  }

  console.log('canvas delete/reveal regression passed');
} finally {
  root.unmount();
  await fetch(`${baseUrl}/api/canvas/file?path=${encodeURIComponent(CANVAS_NAME)}&confirmed=true&secondConfirmed=true`, { method: 'DELETE' }).catch(() => {});
}
