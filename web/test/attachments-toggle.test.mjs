/**
 * 「显示附件」开关验收。
 *
 * 用 esbuild 把真实的 App 组件树打包，在 jsdom 里挂载，连真实的本地后端，
 * 验证：默认隐藏 attachments/ 下的附件 → 打开开关后文件树与快速切换器出现附件
 * → 关闭开关后附件再次消失。
 *
 * 前置：后端必须已启动（默认 http://127.0.0.1:5177），且 vault 的 attachments/
 * 目录中存在附件文件（测试会通过上传接口自行准备）。
 *   node test/attachments-toggle.test.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { installDom, waitFor } from './dom-setup.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');
const BASE_URL = process.env.LATTICE_BASE_URL ?? 'http://127.0.0.1:5177';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[36m${title}\x1b[0m`);
}

function setFieldValue(element, value) {
  const setter = Object.getOwnPropertyDescriptor(
    element.ownerDocument.defaultView.HTMLInputElement.prototype,
    'value',
  ).set;
  setter.call(element, value);
  element.dispatchEvent(new element.ownerDocument.defaultView.Event('input', { bubbles: true }));
}

async function buildEntry() {
  await esbuild.build({
    entryPoints: [path.join(testDir, 'app-entry.jsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    outfile: path.join(testDir, '.build', 'app-entry.mjs'),
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'warning',
  });
}

/** 通过正式上传接口准备附件样例，重复运行安全（接口会自动去重命名）。 */
async function seedAttachmentFixture() {
  const content = '%PDF-1.4\n% 附件开关验收样例\n';
  const response = await fetch(`${BASE_URL}/api/vault/attachments?name=${encodeURIComponent('附件开关验收.pdf')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: content,
  });
  if (!response.ok) throw new Error(`无法上传附件样例：HTTP ${response.status}`);
  const payload = await response.json();
  return payload?.data?.path ?? 'attachments/附件开关验收.pdf';
}

async function main() {
  const attachmentPath = await seedAttachmentFixture();
  const attachmentName = attachmentPath.split('/').pop();

  const { triggerResize } = installDom(BASE_URL);
  triggerResize(1440, 900);

  section('构建与挂载');
  await buildEntry();
  const { mount } = await import(pathToFileURL(path.join(testDir, '.build', 'app-entry.mjs')).href);
  const { container } = mount();

  await waitFor(() => container.querySelector('.nav-item__main'), { label: '目录树加载' });

  section('默认状态（开关关闭）');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const hiddenAttachments = [...container.querySelectorAll('.tree__attachment-file')];
  check('默认不显示附件文件', hiddenAttachments.length === 0, `发现了 ${hiddenAttachments.length} 个附件条目`);

  section('打开「显示附件」开关');
  // 与设置面板 saveSettings 的生效路径一致：派发 settings-change 事件
  window.dispatchEvent(new window.CustomEvent('lattice:settings-change', {
    detail: { autoSave: true, quickSwitcher: true, showAttachments: true },
  }));
  const attachmentNode = await waitFor(
    () => [...container.querySelectorAll('.tree__attachment-file')].find((node) => node.title === attachmentPath) ?? null,
    { label: '附件条目出现在文件树' },
  );
  check('文件树出现附件条目', Boolean(attachmentNode));
  check('附件条目展示扩展名标签', Boolean(attachmentNode?.querySelector('.tree__file-type--pdf')));
  check('附件条目标题为文件名', attachmentNode?.querySelector('.nav-item__label')?.textContent === attachmentName);

  section('快速切换器包含附件');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  const switcherInput = await waitFor(
    () => container.querySelector('.switcher__search input'),
    { label: '切换器打开' },
  );
  setFieldValue(switcherInput, attachmentName.replace('.pdf', ''));
  const attachmentOption = await waitFor(
    () => [...container.querySelectorAll('.switcher__item')]
      .find((item) => item.textContent.includes(attachmentName)) ?? null,
    { label: '切换器出现附件结果' },
  );
  check('切换器匹配到附件文件', Boolean(attachmentOption));
  check('附件结果带有「附件」标记', attachmentOption?.querySelector('.switcher__meta')?.textContent.includes('附件'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  section('关闭「显示附件」开关');
  window.dispatchEvent(new window.CustomEvent('lattice:settings-change', {
    detail: { autoSave: true, quickSwitcher: true, showAttachments: false },
  }));
  await waitFor(
    () => (container.querySelector('.tree__attachment-file') ? null : true),
    { label: '附件条目从文件树移除' },
  );
  check('关闭开关后附件不再显示', !container.querySelector('.tree__attachment-file'));

  console.log(`\n通过 ${passed} 项检查`);
  if (failures.length) {
    console.error(`\x1b[31m失败 ${failures.length} 项：\x1b[0m`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }

  // 收尾：清掉本次上传的附件样例，避免残留在开发库里
  try {
    const response = await fetch(`${BASE_URL}/api/vault/attachments`);
    const payload = await response.json();
    const leftovers = (payload?.data ?? []).filter((file) => file.name.startsWith('附件开关验收'));
    for (const file of leftovers) {
      await fetch(`${BASE_URL}/api/vault/attachments?path=${encodeURIComponent(file.path)}`, { method: 'DELETE' });
    }
  } catch {
    // 清理失败不影响测试结论
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
