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

const FIXTURE_TITLE = `前端冒烟-嵌入样例-${Date.now()}`;

async function seedFolderTreeFixture() {
  const parentName = `__codex-folder-tree-parent-${Date.now()}`;
  const childName = `__codex-folder-tree-child-${Date.now()}`;
  const parentResponse = await fetch(`${BASE_URL}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: parentName }),
  });
  const parentPayload = await parentResponse.json();
  const parent = parentPayload?.data;
  const childResponse = await fetch(`${BASE_URL}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: childName, parentId: parent?.id }),
  });
  const childPayload = await childResponse.json();
  return {
    parent,
    child: childPayload?.data,
    parentName,
    childName,
  };
}

/**
 * 清掉上一次运行可能残留的样例笔记。
 * 测试中途失败时不会有机会执行收尾清理，因此每次开始前都要先扫一遍。
 */
async function cleanupFixtures() {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
  const response = await fetch(`${BASE_URL}/api/notes/index`);
  const payload = await response.json();
  const leftovers = (payload?.data ?? []).filter((note) => note.title === FIXTURE_TITLE);

  for (const note of leftovers) {
    await fetch(`${BASE_URL}/api/notes/${note.id}`, { method: 'DELETE' });
    await pause();
  }
  return leftovers.length;
}

async function seedEmbedFixture() {
  const folders = [];
  for (const name of ['开始使用', '工程笔记']) {
    const existingResponse = await fetch(`${BASE_URL}/api/folders`);
    const existingPayload = await existingResponse.json();
    const existing = (existingPayload?.data ?? []).find((folder) => folder.name === name);
    if (existing) {
      folders.push(existing);
    } else {
      const folderResponse = await fetch(`${BASE_URL}/api/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const folderPayload = await folderResponse.json();
      folders.push(folderPayload?.data);
    }
  }
  await fetch(`${BASE_URL}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '双向链接是什么',
      folderId: folders[0]?.id,
      content: '# 双向链接是什么\n\n知识管理与 FTS5 检索示例。',
    }),
  });
  await fetch(`${BASE_URL}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '关系图谱怎么看',
      folderId: folders[1]?.id,
      content: '# 关系图谱怎么看\n\n[[双向链接是什么]]',
    }),
  });
  // 造一篇带块级嵌入的笔记，用来验证 ![[...]] 的转译与异步注入
  const missingTitle = `前端冒烟-不存在-${Date.now()}`;
  const response = await fetch(`${BASE_URL}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: FIXTURE_TITLE,
      folderId: folders[1]?.id,
      content: `# 嵌入样例\n\n下面是嵌入内容：\n\n![[双向链接是什么]]\n\n以及一个不存在的目标：\n\n![[${missingTitle}]]\n`,
    }),
  });
  const payload = await response.json();
  return payload?.data?.id ?? null;
}

async function main() {
  console.log(`\n前端冒烟测试 → ${BASE_URL}`);

  section('准备');
  await buildEntry();
  check('esbuild 打包成功', true);

  const cleaned = await cleanupFixtures();
  const fixtureId = await seedEmbedFixture();
  const folderTreeFixture = await seedFolderTreeFixture();
  check('后端可用并写入嵌入样例', typeof fixtureId === 'string', cleaned > 0 ? `（清理了 ${cleaned} 篇历史残留）` : '');

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

  check('Obsidian 壳 Ribbon 已渲染', Boolean(container.querySelector('.ribbon')));
  check('状态栏已渲染', Boolean(container.querySelector('.statusbar')));
  check('全文检索输入框存在', Boolean(container.querySelector('input[aria-label="全文检索"]')));
  const folderButtons = await waitFor(
    () => {
      const buttons = [...container.querySelectorAll('.nav-item__main')];
      return buttons.filter((button) => button.textContent.includes('开始使用') || button.textContent.includes('工程笔记')).length >= 2
        ? buttons
        : null;
    },
    { label: '目录树加载' },
  );
  check('目录树渲染出「开始使用」', folderButtons.some((button) => button.textContent.includes('开始使用')));
  check('目录树渲染出「工程笔记」', folderButtons.some((button) => button.textContent.includes('工程笔记')));
  const nestedFolderButtons = await waitFor(
    () => {
      const buttons = [...container.querySelectorAll('.nav-item__main')];
      return buttons.filter((button) => button.textContent.includes(folderTreeFixture.parentName) || button.textContent.includes(folderTreeFixture.childName)).length >= 2
        ? buttons
        : null;
    },
    { label: '嵌套目录树加载' },
  );
  const parentFolderButton = nestedFolderButtons.find((button) => button.textContent.includes(folderTreeFixture.parentName));
  const childFolderButton = nestedFolderButtons.find((button) => button.textContent.includes(folderTreeFixture.childName));
  check('父目录渲染为明确的目录节点', Boolean(parentFolderButton?.querySelector('.tree__folder-icon')));
  check('子目录渲染为明确的目录节点', Boolean(childFolderButton?.querySelector('.tree__folder-icon')));
  check(
    '子目录保留父子路径和层级缩进',
    childFolderButton?.dataset.folderPath === `${folderTreeFixture.parentName}/${folderTreeFixture.childName}`
      && Number.parseInt(childFolderButton?.closest('[role="treeitem"]')?.dataset.folderDepth ?? '0', 10) > Number.parseInt(parentFolderButton?.closest('[role="treeitem"]')?.dataset.folderDepth ?? '0', 10),
  );
  check('至少渲染一篇笔记卡片', container.querySelectorAll('.notecard').length > 0);

  section('AI 文件助手');
  const aiButton = container.querySelector('.ribbon__button[aria-label="AI 文件助手"]');
  check('AI 文件助手入口存在', Boolean(aiButton));
  aiButton?.click();
  await waitFor(() => container.querySelector('.ai-assistant'), { label: 'AI 面板打开' });
  check('AI 面板提供自然语言输入', Boolean(container.querySelector('textarea[aria-label="输入 AI 文件操作"]')));
  const aiSettingsButton = container.querySelector('button[aria-label="AI 连接设置"]');
  aiSettingsButton?.click();
  await waitFor(() => container.querySelector('.ai-assistant__settings'), { label: 'AI 设置展开' });
  check('AI 设置提供访问令牌配置', container.querySelector('.ai-assistant__settings')?.textContent.includes('工作区访问令牌'));
  container.querySelector('button[aria-label="关闭连接设置"]')?.click();
  await waitFor(() => !container.querySelector('.ai-assistant__settings'), { label: 'AI 设置关闭' });
  const organizeQuickAction = [...container.querySelectorAll('.ai-assistant__quick-actions button')]
    .find((button) => button.textContent.includes('整理建议'));
  check('AI 提供整理快捷操作', Boolean(organizeQuickAction));
  organizeQuickAction?.click();
  const aiResponse = await waitFor(
    () => [...container.querySelectorAll('.ai-message__suggestions')].find((node) => node.textContent.includes('按文件类型分组'))
      ?? container.querySelector('.ai-assistant__error'),
    { label: 'AI 本地助手响应' },
  );
  check('AI 本地助手返回整理建议', aiResponse?.classList.contains('ai-message__suggestions'), container.querySelector('.ai-assistant__error')?.textContent ?? '');
  container.querySelector('.ai-assistant__header-actions button[aria-label="关闭 AI 文件助手"]')?.click();
  await waitFor(() => !container.querySelector('.ai-assistant'), { label: 'AI 面板关闭' });

  section('设置中的模型管理');
  container.querySelector('button[aria-label="设置"]')?.click();
  await waitFor(() => container.querySelector('.settings-workspace'), { label: '设置面板打开' });
  const modelSettingsButton = [...container.querySelectorAll('.settings-nav__item')]
    .find((button) => button.textContent.includes('模型'));
  check('设置侧栏包含模型栏目', Boolean(modelSettingsButton));
  modelSettingsButton?.click();
  await waitFor(() => container.querySelector('.model-center'), { label: '模型管理页面打开' });
  check('模型管理提供添加模型入口', Boolean(container.querySelector('.model-center__intro .btn')));
  check('模型管理不再展示内置模型分组', !container.querySelector('.model-center__group-title'));
  check('模型管理列出可编辑的自定义模型', container.querySelectorAll('.model-center__row').length >= 1);
  const addModelButton = container.querySelector('.model-center__intro .btn');
  addModelButton?.click();
  await waitFor(() => container.querySelector('.model-center__chooser'), { label: '模型服务商选择打开' });
  check('模型管理提供服务商选择', container.querySelectorAll('.model-center__provider').length >= 10);
  container.querySelector('.model-center__provider--wide')?.click();
  await waitFor(() => container.querySelector('.model-center__form'), { label: '自定义模型表单打开' });
  check('模型管理提供 API 接口字段', Boolean(container.querySelector('.model-center__form input[placeholder*="api.openai.com"]')));
  container.querySelector('.model-center__back')?.click();
  await waitFor(() => container.querySelector('.model-center__chooser'), { label: '返回服务商选择' });
  container.querySelector('.model-center__close')?.click();
  await waitFor(() => !container.querySelector('.model-center__chooser'), { label: '模型添加弹窗关闭' });
  container.querySelector('.settings-content__head button[aria-label="关闭设置"]')?.click();
  await waitFor(() => !container.querySelector('.settings-workspace'), { label: '设置面板关闭' });

  section('目录右键菜单');
  const folderTrigger = folderButtons
    .find((button) => button.textContent.includes('工程笔记'));
  folderTrigger?.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 120,
    clientY: 120,
  }));
  await waitFor(() => document.querySelector('.context-menu'), { label: '目录右键菜单打开' });
  const folderMenuText = document.querySelector('.context-menu')?.textContent ?? '';
  check('目录菜单包含 Obsidian 常用动作', ['新建笔记', '新建文件夹', '新建白板', '创建副本', '将文件夹移动到', '在文件夹中查找', '收藏', '复制路径', '重命名', '删除'].every((label) => folderMenuText.includes(label)));
  check('数据库入口明确为暂未支持', Boolean(document.querySelector('.context-menu .menu__item:disabled')));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => !document.querySelector('.context-menu'), { label: '目录右键菜单关闭' });

  section('文件右键菜单');
  const treeNote = await waitFor(() => container.querySelector('.tree__note'), { label: '目录树文件加载' });
  treeNote.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 160,
    clientY: 160,
  }));
  await waitFor(() => document.querySelector('.context-menu'), { label: '文件右键菜单打开' });
  const noteMenuText = document.querySelector('.context-menu')?.textContent ?? '';
  check('文件菜单包含文件操作', ['在新标签页中打开', '创建副本', '将文件移动到', '收藏', '复制路径', '重命名', '删除'].every((label) => noteMenuText.includes(label)));
  check('文件菜单保留暂未支持功能的明确状态', Boolean(document.querySelector('.context-menu .menu__item:disabled')));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => !document.querySelector('.context-menu'), { label: '文件右键菜单关闭' });

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
  const searchInput = container.querySelector('input[aria-label="全文检索"]');
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
  // 默认 Obsidian 壳走 Ribbon 按钮；?shell=topbar 下回退到顶栏分段控件
  const graphTab = container.querySelector('.ribbon__button[aria-label="图谱"]')
    ?? [...container.querySelectorAll('.segmented button')].find((b) => b.textContent === '图谱');
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

  section('画布资源选择');
  const canvasTab = container.querySelector('.ribbon__button[aria-label="画布"]')
    ?? [...container.querySelectorAll('.segmented button')].find((b) => b.textContent === '画布');
  check('画布视图切换按钮存在', Boolean(canvasTab));
  canvasTab.click();
  await waitFor(() => container.querySelector('.canvas-view'), { label: '画布组件挂载' });
  check('画布提供图片入口', Boolean([...container.querySelectorAll('.canvas-toolbar button')].find((button) => button.textContent.includes('添加图片'))));
  const addCanvasNoteButton = [...container.querySelectorAll('.canvas-toolbar button')].find((button) => button.textContent.includes('添加笔记'));
  addCanvasNoteButton.click();
  await waitFor(() => container.querySelector('.canvas-picker-modal'), { label: '笔记选择器打开' });
  check('笔记选择器提供标题搜索', Boolean(container.querySelector('input[aria-label="搜索笔记标题"]')));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => !container.querySelector('.canvas-picker-modal'), { label: '笔记选择器关闭' });

  const addCanvasImageButton = [...container.querySelectorAll('.canvas-toolbar button')].find((button) => button.textContent.includes('添加图片'));
  addCanvasImageButton.click();
  await waitFor(() => container.querySelector('.canvas-picker-modal'), { label: '图片选择器打开' });
  check('图片选择器提供路径搜索', Boolean(container.querySelector('input[aria-label="搜索图片路径"]')));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => !container.querySelector('.canvas-picker-modal'), { label: '图片选择器关闭' });

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
  const notesTab = container.querySelector('.ribbon__button[aria-label="笔记"]')
    ?? [...container.querySelectorAll('.segmented button')].find((b) => b.textContent === '笔记');
  notesTab.click();
  await waitFor(() => container.querySelector('.editor__title'), { label: '切回笔记视图' });

  const editorTitle = container.querySelector('.editor__title');
  check('编辑器仍处于打开状态', Boolean(editorTitle));
  const beforeTitle = editorTitle.value;
  // 不拿原标题拼后缀：示例数据的标题可能已被历史运行拉长到接近服务端 200 字上限，
  // 再拼一段就会 422，保存永远到不了 saved。用一个独立且唯一的标题，改完再还原。
  const editedTitle = `冒烟测试-自动保存-${Date.now()}`;
  setFieldValue(editorTitle, editedTitle);
  // 必须先等状态离开 saved：改完标题的一瞬间 DOM 里仍是上一次的 .savestate--saved，
  // 直接等它就会假通过 —— 测试会立刻往下走，还原的那次防抖保存根本来不及发出。
  await waitFor(
    () => !container.querySelector('.savestate--saved'),
    { label: '进入待保存状态' },
  );
  await waitFor(
    () => container.querySelector('.savestate--saved'),
    { label: '自动保存完成', timeout: 6000 },
  );
  check('修改标题后自动保存成功', Boolean(container.querySelector('.savestate--saved')));

  // 还原标题，避免污染示例数据
  setFieldValue(editorTitle, beforeTitle);
  await waitFor(
    () => !container.querySelector('.savestate--saved'),
    { label: '进入还原保存状态' },
  );
  await waitFor(() => container.querySelector('.savestate--saved'), { label: '还原标题', timeout: 6000 });

  section('运行期错误');
  const realErrors = consoleErrors.filter((text) => !text.includes('Warning:'));
  check('控制台没有未处理异常', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

  // 清理冒烟产生的样例笔记
  if (fixtureId) {
    await fetch(`${BASE_URL}/api/notes/${fixtureId}`, { method: 'DELETE' });
  }
  if (folderTreeFixture.parent?.id) {
    await fetch(`${BASE_URL}/api/folders/${folderTreeFixture.parent.id}`, { method: 'DELETE' });
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
