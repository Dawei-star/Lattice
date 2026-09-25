/**
 * 前端冒烟测试。
 *
 * 用 esbuild 把真实的 App 组件树打包，在 jsdom 里挂载，连真实的本地后端，
 * 验证「渲染 → 取数 → 交互 → 重渲染」这条完整链路，而不是只做编译检查。
 *
 * 前置：后端必须已启动（默认 http://127.0.0.1:5177）。
 *   node test/run-smoke.mjs
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

/** 绕过 React 的值追踪器，模拟真实用户输入 */
function setFieldValue(element, value) {
  const prototype = element.tagName === 'TEXTAREA'
    ? element.ownerDocument.defaultView.HTMLTextAreaElement.prototype
    : element.ownerDocument.defaultView.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
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

const FIXTURE_TITLE = '前端冒烟-嵌入样例';

/**
 * 清掉上一次运行可能残留的样例笔记。
 * 测试中途失败时不会有机会执行收尾清理，因此每次开始前都要先扫一遍。
 */
async function cleanupFixtures() {
  const response = await fetch(`${BASE_URL}/api/notes/index`);
  const payload = await response.json();
  const leftovers = (payload?.data ?? []).filter((note) => note.title === FIXTURE_TITLE);

  for (const note of leftovers) {
    await fetch(`${BASE_URL}/api/notes/${note.id}`, { method: 'DELETE' });
  }
  return leftovers.length;
}

async function seedEmbedFixture() {
  // 造一篇带块级嵌入的笔记，用来验证 ![[...]] 的转译与异步注入
  const response = await fetch(`${BASE_URL}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: FIXTURE_TITLE,
      content: '# 嵌入样例\n\n下面是嵌入内容：\n\n![[双向链接是什么]]\n\n以及一个不存在的目标：\n\n![[这个笔记不存在]]\n',
    }),
  });
  const payload = await response.json();
  return payload?.data?.id ?? null;
}

// 1x1 透明 PNG，用于附件管理面板渲染
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const FIXTURE_ATTACHMENT_NAME = '前端冒烟附件.png';

async function seedAttachmentFixture() {
  const response = await fetch(`${BASE_URL}/api/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FIXTURE_ATTACHMENT_NAME, mime: 'image/png', data: PNG_B64 }),
  });
  const payload = await response.json();
  return payload?.data?.id ?? null;
}

async function cleanupAttachmentFixtures() {
  const response = await fetch(`${BASE_URL}/api/attachments`);
  const payload = await response.json();
  const leftovers = (payload?.data ?? []).filter((a) => a.name === FIXTURE_ATTACHMENT_NAME);
  for (const a of leftovers) {
    await fetch(`${BASE_URL}/api/attachments/${a.id}`, { method: 'DELETE' });
  }
}

async function main() {
  console.log(`\n前端冒烟测试 → ${BASE_URL}`);

  section('准备');
  await buildEntry();
  check('esbuild 打包成功', true);

  const cleaned = await cleanupFixtures();
  await cleanupAttachmentFixtures();
  const fixtureId = await seedEmbedFixture();
  check('后端可用并写入嵌入样例', typeof fixtureId === 'string', cleaned > 0 ? `（清理了 ${cleaned} 篇历史残留）` : '');
  const attachmentId = await seedAttachmentFixture();
  check('后端可用并写入附件样例', typeof attachmentId === 'string');

  const { triggerResize } = installDom(BASE_URL);

  // 收集运行期错误：React 的 act 警告由测试自身引起，不计入失败
  const consoleErrors = [];
  const originalError = console.error;
  console.error = (...args) => {
    const text = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
    if (!text.includes('not wrapped in act')) consoleErrors.push(text);
    originalError.apply(console, args);
  };

  section('首次渲染');
  const { mount } = await import(pathToFileURL(path.join(testDir, '.build', 'app-entry.mjs')).href);
  const { container } = mount();

  await waitFor(() => container.querySelector('.notecard__title'), { label: '笔记列表加载' });

  check('品牌标题渲染', container.textContent.includes('格物 Lattice'));
  check('顶栏检索框存在', Boolean(container.querySelector('.topbar__search input')));
  check('目录树渲染出「开始使用」', container.textContent.includes('开始使用'));
  check('目录树渲染出「工程笔记」', container.textContent.includes('工程笔记'));
  check('至少渲染一篇笔记卡片', container.querySelectorAll('.notecard').length > 0);

  const overviewStats = container.querySelectorAll('.stats__item dd');
  check('统计区块渲染出数据', overviewStats.length >= 5);

  section('打开笔记与 Markdown 预览');
  const firstCard = container.querySelector('.notecard__main');
  firstCard.click();

  const titleInput = await waitFor(() => {
    const input = container.querySelector('.editor__title');
    return input && input.value ? input : null;
  }, { label: '编辑器载入标题' });
  check('编辑器标题已载入', titleInput.value.length > 0, `实际「${titleInput.value}」`);

  await waitFor(() => container.querySelector('.markdown-body h1'), { label: '渲染 Markdown' });
  const preview = container.querySelector('.markdown-body');
  check('Markdown 渲染出一级标题', Boolean(preview.querySelector('h1')));
  check('双链被渲染为 wiki-link 元素', preview.querySelectorAll('.wiki-link').length > 0);
  check('正文中的双链没有残留原始 [[ ]]', !preview.textContent.includes('[['));

  const panel = container.querySelector('.linkpanel');
  check('关系面板渲染出链/反链分组', panel.textContent.includes('出链') && panel.textContent.includes('反向链接'));

  section('块级嵌入');
  const embedNote = container.querySelector('.notecard__title');
  void embedNote;
  // 直接通过数据层打开嵌入样例，避免依赖列表顺序
  const embedTitleNode = [...container.querySelectorAll('.notecard__title')]
    .find((node) => node.textContent.includes('嵌入样例'));
  check('嵌入样例出现在列表中', Boolean(embedTitleNode));
  if (embedTitleNode) {
    embedTitleNode.closest('.notecard__main').click();
    await waitFor(
      () => container.querySelector('.note-embed[data-embed-state="ready"]'),
      { label: '嵌入内容注入完成' },
    );

    const readyEmbed = container.querySelector('.note-embed[data-embed-state="ready"]');
    check('已解析的嵌入卡片状态为 ready', Boolean(readyEmbed));
    check('嵌入内容里渲染出了被嵌入笔记的标题', readyEmbed.textContent.includes('双向链接是什么'));
    check('嵌入内容真的展开了正文', Boolean(readyEmbed.querySelector('.markdown-body, h1, p')));

    const missingEmbed = container.querySelector('.note-embed[data-embed-state="missing"]');
    check('指向不存在笔记的嵌入降级为 missing', Boolean(missingEmbed));
  }

  section('全文检索');
  const searchInput = container.querySelector('.topbar__search input');
  setFieldValue(searchInput, '关系图谱');
  // 注意：策略标签在「检索中…」阶段就已挂载，必须等它落到真实策略才算结果到达
  const strategyNode = await waitFor(
    () => {
      const node = container.querySelector('.listpane__strategy');
      return node && !node.textContent.includes('检索中') ? node : null;
    },
    { label: '检索结果返回' },
  );
  const strategyText = strategyNode.textContent;
  check('检索走服务端策略并回显', strategyText.includes('FTS5') || strategyText.includes('LIKE'), `实际「${strategyText}」`);
  check('检索结果被高亮', Boolean(container.querySelector('.notecard__excerpt mark')));

  setFieldValue(searchInput, '');
  await waitFor(() => !container.querySelector('.listpane__strategy'), { label: '清空检索恢复列表' });
  check('清空检索后恢复笔记列表', container.querySelectorAll('.notecard').length > 0);

  section('图谱视图');
  const graphTab = [...container.querySelectorAll('.segmented button')].find((b) => b.textContent === '图谱');
  check('图谱视图切换按钮存在', Boolean(graphTab));
  graphTab.click();
  triggerResize(1000, 600);

  await waitFor(() => container.querySelector('.graph__canvas'), { label: '图谱组件挂载' });
  check('Canvas 图谱已挂载', Boolean(container.querySelector('.graph__canvas')));

  // 不能只等 overlay 消失：请求发起前 overlay 本就不存在。
  // 必须等到统计里出现真实的非零节点数，才能确认图谱数据已就绪。
  const graphStatsNode = await waitFor(
    () => {
      const node = container.querySelector('.graph__stats');
      if (!node) return null;
      const match = node.textContent.match(/(\d+)\s*节点/);
      return match && Number(match[1]) > 0 ? node : null;
    },
    { label: '图谱数据加载完成' },
  );

  const graphStats = graphStatsNode.textContent;
  check('图谱统计显示真实节点数', /[1-9]\d*\s*节点/.test(graphStats), `实际「${graphStats}」`);
  check('图谱渲染未抛异常', consoleErrors.length === 0, consoleErrors[0] ?? '');

  section('附件管理面板');
  const attachmentsTab = [...container.querySelectorAll('.segmented button')].find((b) => b.textContent === '附件');
  check('附件视图切换按钮存在', Boolean(attachmentsTab));
  attachmentsTab.click();
  const attCard = await waitFor(
    () => {
      const cards = [...container.querySelectorAll('.attachment-card')];
      return cards.some((c) => c.textContent.includes(FIXTURE_ATTACHMENT_NAME)) ? cards : null;
    },
    { label: '附件列表加载' },
  );
  check('附件面板渲染出上传的附件卡片', Boolean(attCard && attCard.length > 0));
  const fixtureCard = attCard.find((c) => c.textContent.includes(FIXTURE_ATTACHMENT_NAME));
  check('未引用附件显示 refCount 0 徽标', /未引用|0/.test(fixtureCard.textContent));
  check('附件卡片带删除入口', Boolean(fixtureCard.querySelector('.attachment-card__delete')));

  section('导出静态站点');
  const exportBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('导出静态站点'));
  check('侧栏导出按钮存在', Boolean(exportBtn));
  check('导出按钮初始可用', exportBtn && !exportBtn.disabled);
  exportBtn.click();
  const previewLink = await waitFor(() => container.querySelector('.export-block__link'), {
    label: '导出完成并出现预览链接',
    timeout: 12000,
  });
  check('导出成功后给出预览入口', Boolean(previewLink && previewLink.getAttribute('href')?.startsWith('/export/')));
  check('预览链接以新标签打开', previewLink?.getAttribute('target') === '_blank');

  section('快速切换器');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  await waitFor(() => container.querySelector('.switcher'), { label: '切换器打开' });
  check('Ctrl+K 打开快速切换器', Boolean(container.querySelector('.switcher')));

  const switcherInput = container.querySelector('.switcher__search input');
  setFieldValue(switcherInput, '架构');
  await waitFor(() => container.querySelectorAll('.switcher__item').length > 0, { label: '切换器检索结果' });
  check('切换器按标题过滤出结果', container.querySelectorAll('.switcher__item').length > 0);

  setFieldValue(switcherInput, '一个全新的笔记标题');
  await waitFor(() => container.querySelector('.switcher__item--create'), { label: '出现新建入口' });
  check('无精确匹配时提供「新建」入口', Boolean(container.querySelector('.switcher__item--create')));

  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => !container.querySelector('.switcher'), { label: '切换器关闭' });
  check('Esc 关闭切换器', true);

  section('编辑与自动保存');
  // 图谱视图下编辑区是卸载的，先切回笔记视图
  const notesTab = [...container.querySelectorAll('.segmented button')].find((b) => b.textContent === '笔记');
  notesTab.click();
  await waitFor(() => container.querySelector('.editor__title'), { label: '切回笔记视图' });

  const editorTitle = container.querySelector('.editor__title');
  check('编辑器仍处于打开状态', Boolean(editorTitle));
  const beforeTitle = editorTitle.value;
  setFieldValue(editorTitle, `${beforeTitle}（已改）`);
  await waitFor(
    () => container.querySelector('.savestate--saved') || container.querySelector('.savestate--dirty'),
    { label: '触发自动保存状态' },
  );
  await waitFor(
    () => container.querySelector('.savestate--saved'),
    { label: '自动保存完成', timeout: 6000 },
  );
  check('修改标题后自动保存成功', Boolean(container.querySelector('.savestate--saved')));

  // 还原标题，避免污染示例数据
  setFieldValue(editorTitle, beforeTitle);
  await waitFor(() => container.querySelector('.savestate--saved'), { label: '还原标题', timeout: 6000 });

  section('版本历史面板');
  // 上一步「编辑与自动保存」改动过标题，当前笔记已留下一条历史快照。
  const historyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === '历史');
  check('编辑区有「历史」入口按钮', Boolean(historyBtn));
  historyBtn.click();
  await waitFor(() => container.querySelector('.history'), { label: '版本历史弹窗打开' });
  check('版本历史弹窗渲染', Boolean(container.querySelector('.history')));

  const historyItems = await waitFor(() => {
    const nodes = container.querySelectorAll('.history__item');
    return nodes.length > 0 ? nodes : null;
  }, { label: '历史列表加载' });
  check('历史列表至少渲染一条版本', historyItems.length >= 1, `实际 ${historyItems.length} 条`);

  historyItems[0].click();
  const previewContent = await waitFor(() => {
    const pre = container.querySelector('.history__content pre');
    return pre && pre.textContent.length >= 0 && container.querySelector('.history__foot .btn--primary')
      ? pre
      : null;
  }, { label: '版本内容预览就绪' });
  check('选中版本后渲染出正文预览', Boolean(previewContent));
  const restoreBtn = container.querySelector('.history__foot .btn--primary');
  check('预览底部有「恢复此版本」按钮', Boolean(restoreBtn && restoreBtn.textContent.includes('恢复')));

  // 真正走一遍恢复链路（confirm 在 jsdom 下默认返回 undefined，需桩为 true）；
  // 选中的是最近一条快照，当前内容与其一致，后端按 noop 处理，不会污染数据，但完整跑通
  // 取版本 → POST restore → 刷新当前笔记 → 编辑区同步草稿 这条 UI 路径。
  const originalConfirm = window.confirm;
  window.confirm = () => true;
  restoreBtn.click();
  await waitFor(() => !container.querySelector('.history'), { label: '恢复后弹窗关闭' });
  window.confirm = originalConfirm;
  check('恢复后弹窗关闭且编辑区回到已保存态', Boolean(container.querySelector('.savestate--saved')));

  section('运行期错误');
  const realErrors = consoleErrors.filter((text) => !text.includes('Warning:'));
  check('控制台没有未处理异常', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

  // 清理冒烟产生的样例笔记
  if (fixtureId) {
    await fetch(`${BASE_URL}/api/notes/${fixtureId}`, { method: 'DELETE' });
  }

  console.error = originalError;

  console.log(`\n${'─'.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m全部通过：${passed} 项检查\x1b[0m\n`);
  } else {
    console.log(`\x1b[31m失败 ${failures.length} 项 / 通过 ${passed} 项\x1b[0m`);
    for (const failure of failures) console.log(`  · ${failure}`);
    console.log('');
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n\x1b[31m冒烟测试无法执行：${error.message}\x1b[0m`);
  console.error(error.stack);
  process.exit(1);
});
