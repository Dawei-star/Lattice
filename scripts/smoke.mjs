#!/usr/bin/env node
/**
 * 端到端冒烟测试：对运行中的后端逐项验证接口契约。
 *
 *   node scripts/smoke.mjs
 *   SMOKE_BASE_URL=http://127.0.0.1:5177 node scripts/smoke.mjs
 *
 * 覆盖：探针 / 笔记 CRUD / 目录 / 标签 / 全文检索（中英文、长短词）/ 图谱 / 附件上传托管 /
 *       参数校验错误契约 / 404 契约 / CORS 白名单 / 创建幂等性 / 双向链接解析。
 */
const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5177';

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

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
}

function section(title) {
  console.log(`\n\x1b[36m${title}\x1b[0m`);
}

async function main() {
  console.log(`\n冒烟测试目标：${BASE}`);

  section('探针');
  const health = await api('/health');
  check('GET /health 返回 200', health.status === 200, `实际 ${health.status}`);
  check('GET /health 状态为 ok', health.body?.data?.status === 'ok');
  const ready = await api('/ready');
  check('GET /ready 返回 200', ready.status === 200, `实际 ${ready.status}`);
  check('GET /ready 数据库可用', ready.body?.data?.database === 'up');

  section('目录');
  const folders = await api('/api/folders');
  check('GET /api/folders 返回 200', folders.status === 200);
  check('GET /api/folders 返回数组', Array.isArray(folders.body?.data));
  check('目录树带有 noteCount 与 children', folders.body?.data?.[0]?.children !== undefined);

  const createdFolder = await api('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name: `冒烟测试目录-${Date.now()}` }),
  });
  check('POST /api/folders 返回 201', createdFolder.status === 201, `实际 ${createdFolder.status}`);
  const folderId = createdFolder.body?.data?.id;
  check('新建目录返回 id', typeof folderId === 'string' && folderId.length === 36);

  const duplicateFolder = await api('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name: createdFolder.body?.data?.name }),
  });
  check('同级重名目录返回 409', duplicateFolder.status === 409, `实际 ${duplicateFolder.status}`);

  const emptyName = await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: '' }) });
  check('空目录名返回 422', emptyName.status === 422, `实际 ${emptyName.status}`);
  check('校验错误体含 details 数组', Array.isArray(emptyName.body?.error?.details));
  check('校验错误体含 requestId', typeof emptyName.body?.error?.requestId === 'string');

  section('笔记 CRUD 与幂等');
  const noteId = crypto.randomUUID();
  const created = await api('/api/notes', {
    method: 'POST',
    body: JSON.stringify({
      id: noteId,
      title: '冒烟测试笔记',
      folderId,
      content: '# 冒烟测试\n\n链接到 [[欢迎使用格物]] 与 [[一个不存在的目标]]。\n\n标签：#冒烟 #测试',
    }),
  });
  check('POST /api/notes 返回 201', created.status === 201, `实际 ${created.status}`);
  check('创建后自动解析出 2 个标签', created.body?.data?.tags?.length === 2, `实际 ${created.body?.data?.tags?.length}`);
  check('创建后自动解析出 2 条出链', created.body?.data?.outgoing?.length === 2, `实际 ${created.body?.data?.outgoing?.length}`);
  check('指向已存在笔记的链接被解析', created.body?.data?.outgoing?.some((l) => l.resolved === true));
  check('指向不存在笔记的链接为悬空', created.body?.data?.outgoing?.some((l) => l.resolved === false));

  const replay = await api('/api/notes', {
    method: 'POST',
    body: JSON.stringify({ id: noteId, title: '重复提交不应产生新笔记', content: 'x' }),
  });
  check('相同 id 重复 POST 幂等（返回 201 但同一条）', replay.body?.data?.id === noteId);

  const fetched = await api(`/api/notes/${noteId}`);
  check('GET /api/notes/:id 返回 200', fetched.status === 200);
  check('重复 POST 未覆盖原标题', fetched.body?.data?.title === '冒烟测试笔记', `实际 ${fetched.body?.data?.title}`);

  const patched = await api(`/api/notes/${noteId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content: '# 冒烟测试\n\n只剩 [[双向链接是什么]] 了。\n\n#冒烟' }),
  });
  check('PATCH /api/notes/:id 返回 200', patched.status === 200);
  check('更新后标签随正文同步为 1 个', patched.body?.data?.tags?.length === 1, `实际 ${patched.body?.data?.tags?.length}`);
  check('更新后出链随正文重建为 1 条', patched.body?.data?.outgoing?.length === 1);

  const pinned = await api(`/api/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ isPinned: true }) });
  check('PATCH isPinned 生效', pinned.body?.data?.isPinned === true);

  const list = await api('/api/notes?limit=3&sort=updated');
  check('GET /api/notes 返回 200', list.status === 200);
  check('列表带 meta.total', typeof list.body?.meta?.total === 'number');
  check('列表按 limit 截断', list.body?.data?.length <= 3);
  check('列表项含摘要与链接计数', list.body?.data?.[0]?.excerpt !== undefined && list.body?.data?.[0]?.outgoingCount !== undefined);
  check('置顶笔记排在最前', list.body?.data?.[0]?.isPinned === true);

  const byFolder = await api(`/api/notes?folderId=${folderId}`);
  check('按目录过滤生效', byFolder.body?.data?.every((n) => n.folderId === folderId));
  const unfiled = await api('/api/notes?folderId=__none__');
  check('未分类过滤生效', unfiled.body?.data?.every((n) => n.folderId === null));

  const index = await api('/api/notes/index');
  check('GET /api/notes/index 返回 200', index.status === 200);
  check('索引含全部笔记且不含正文', index.body?.data?.length > 0 && index.body.data[0].content === undefined);

  section('全文检索');
  const fts = await api(`/api/search?q=${encodeURIComponent('双向链接')}`);
  check('中文长词检索命中', fts.body?.data?.length > 0, `策略 ${fts.body?.meta?.strategy}`);
  check('中文长词走 FTS 策略', fts.body?.meta?.strategy === 'fts', `实际 ${fts.body?.meta?.strategy}`);
  check('检索结果带上下文片段', (fts.body?.data?.[0]?.excerpt ?? '').length > 0);

  const shortQuery = await api(`/api/search?q=${encodeURIComponent('知识')}`);
  check('两字中文检索命中（LIKE 兜底）', shortQuery.body?.data?.length > 0, `策略 ${shortQuery.body?.meta?.strategy}`);
  check('短词走 LIKE 策略', String(shortQuery.body?.meta?.strategy).startsWith('like'));

  const english = await api('/api/search?q=FTS5');
  check('英文检索命中', english.body?.data?.length > 0);

  const noResult = await api('/api/search?q=zzz绝不存在的词zzz');
  check('无结果时返回空数组而非报错', noResult.status === 200 && noResult.body?.data?.length === 0);

  const emptyQuery = await api('/api/search?q=');
  check('空检索词返回 422', emptyQuery.status === 422, `实际 ${emptyQuery.status}`);

  const wildcard = await api('/api/search?q=%25');
  check('LIKE 通配符被转义（不返回全库）', wildcard.body?.data?.length === 0, `实际 ${wildcard.body?.data?.length}`);

  section('标签与图谱');
  const tags = await api('/api/tags');
  check('GET /api/tags 返回 200', tags.status === 200);
  check('标签带 noteCount', tags.body?.data?.[0]?.noteCount !== undefined);
  check('标签按引用数倒序', tags.body.data.length < 2 || tags.body.data[0].noteCount >= tags.body.data[1].noteCount);

  const graph = await api('/api/graph');
  check('GET /api/graph 返回 200', graph.status === 200);
  check('图谱返回 nodes', Array.isArray(graph.body?.data?.nodes));
  check('图谱返回 edges', Array.isArray(graph.body?.data?.edges));
  check('图谱节点带 degree', typeof graph.body?.data?.nodes?.[0]?.degree === 'number');
  check('图谱边两端均存在', graph.body.data.edges.every((e) =>
    graph.body.data.nodes.some((n) => n.id === e.source) && graph.body.data.nodes.some((n) => n.id === e.target)));

  section('总览');
  const overview = await api('/api/meta/overview');
  check('GET /api/meta/overview 返回 200', overview.status === 200);
  check('总览含笔记/目录/标签/链接计数',
    typeof overview.body?.data?.noteCount === 'number' &&
    typeof overview.body?.data?.folderCount === 'number' &&
    typeof overview.body?.data?.linkCount === 'number');

  section('错误契约');
  const missing = await api(`/api/notes/${crypto.randomUUID()}`);
  check('不存在的笔记返回 404', missing.status === 404, `实际 ${missing.status}`);
  check('404 错误体结构规范', missing.body?.error?.code === 'NOT_FOUND' && typeof missing.body.error.requestId === 'string');

  const badUuid = await api('/api/notes/not-a-uuid');
  check('非法 UUID 返回 422', badUuid.status === 422, `实际 ${badUuid.status}`);

  const unknownRoute = await api('/api/does-not-exist');
  check('未知接口返回 404', unknownRoute.status === 404);

  const badJson = await fetch(`${BASE}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ 这不是 JSON',
  });
  check('非法 JSON 体返回 400', badJson.status === 400, `实际 ${badJson.status}`);

  section('CORS 与安全头');
  const preflight = await fetch(`${BASE}/api/notes`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
  });
  check('白名单来源预检返回 204', preflight.status === 204, `实际 ${preflight.status}`);
  check('白名单来源回显 ACAO', preflight.headers.get('access-control-allow-origin') === 'http://localhost:5173');

  const blocked = await fetch(`${BASE}/api/notes`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://evil.example.com', 'Access-Control-Request-Method': 'POST' },
  });
  check('非白名单来源不下发 ACAO', blocked.headers.get('access-control-allow-origin') === null);

  check('响应带 X-Content-Type-Options', ready.headers.get('x-content-type-options') === 'nosniff');
  check('响应带 X-Request-Id', typeof ready.headers.get('x-request-id') === 'string');
  check('未暴露 X-Powered-By', ready.headers.get('x-powered-by') === null);

  section('附件上传与托管');
  // 1x1 透明 PNG
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const uploaded = await api('/api/attachments', {
    method: 'POST',
    body: JSON.stringify({ name: '冒烟点.png', mime: 'image/png', data: PNG_B64 }),
  });
  check('POST /api/attachments 返回 201', uploaded.status === 201, `实际 ${uploaded.status}`);
  const attachmentUrl = uploaded.body?.data?.url;
  check('上传返回同源可访问 URL', typeof attachmentUrl === 'string' && attachmentUrl.startsWith('/attachments/'));
  check('上传登记原始文件名与大小', uploaded.body?.data?.name === '冒烟点.png' && uploaded.body?.data?.size > 0);

  const served = await api(attachmentUrl ?? '/attachments/none');
  check('附件可按 URL 取回', served.status === 200, `实际 ${served.status}`);
  check('附件下发正确 Content-Type', served.headers.get('content-type') === 'image/png', `实际 ${served.headers.get('content-type')}`);
  check('附件响应带 nosniff', served.headers.get('x-content-type-options') === 'nosniff');

  const svgRejected = await api('/api/attachments', {
    method: 'POST',
    body: JSON.stringify({ name: 'x.svg', mime: 'image/svg+xml', data: PNG_B64 }),
  });
  check('不支持的类型（svg）返回 422', svgRejected.status === 422, `实际 ${svgRejected.status}`);

  const listed = await api('/api/attachments');
  check('GET /api/attachments 列表包含新附件', Array.isArray(listed.body?.data) && listed.body.data.some((a) => a.url === attachmentUrl));
  check('未被正文引用的附件 refCount 为 0', listed.body?.data.find((a) => a.url === attachmentUrl)?.refCount === 0);

  // 被笔记正文引用后：refCount 变 1，且引用者指向该笔记
  const refd = await api('/api/attachments', {
    method: 'POST',
    body: JSON.stringify({ name: '被引用.png', mime: 'image/png', data: PNG_B64 }),
  });
  const refdUrl = refd.body?.data?.url;
  await api(`/api/notes/${noteId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content: `引用一张图：![配图](${refdUrl})` }),
  });
  const listed2 = await api('/api/attachments');
  const refdRow = listed2.body?.data?.find((a) => a.url === refdUrl);
  check('被正文引用后 refCount 为 1', refdRow?.refCount === 1, `实际 ${refdRow?.refCount}`);
  check('引用者指向该笔记', refdRow?.referrers?.[0]?.id === noteId);

  const missingAttachment = await api('/attachments/definitely-missing.png');
  check('不存在的附件返回 404', missingAttachment.status === 404, `实际 ${missingAttachment.status}`);

  // cleanup 只回收孤儿：uploaded 未被引用应删除，refd 被笔记引用应保留
  const cleanup = await api('/api/attachments/cleanup', { method: 'POST', body: '{}' });
  const removedIds = (cleanup.body?.data?.removed ?? []).map((r) => r.id);
  check(
    'POST /api/attachments/cleanup 回收孤儿附件',
    removedIds.includes(uploaded.body?.data?.id),
    `removed=${JSON.stringify(removedIds)}`,
  );
  check('cleanup 保留被引用的附件', !removedIds.includes(refd.body?.data?.id));
  const servedAfterCleanup = await api(attachmentUrl ?? '/attachments/none');
  check('清理后孤儿附件不可再取回', servedAfterCleanup.status === 404, `实际 ${servedAfterCleanup.status}`);
  const refdAfterCleanup = await api(refdUrl ?? '/attachments/none');
  check('被引用的附件在清理后仍可取回', refdAfterCleanup.status === 200, `实际 ${refdAfterCleanup.status}`);
  // 让 refd 也变成孤儿：删除引用它的笔记的正文，随后清掉，避免残留
  await api(`/api/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ content: '（已移除配图引用）' }) });
  await api('/api/attachments/cleanup', { method: 'POST', body: '{}' });

  // 单附件删除路径（DELETE）：再传一个，按 id 删除
  const second = await api('/api/attachments', {
    method: 'POST',
    body: JSON.stringify({ name: '冒烟点2.png', mime: 'image/png', data: PNG_B64 }),
  });
  const secondUrl = second.body?.data?.url;
  const attachmentId = second.body?.data?.id;
  const deletedAttachment = await api(`/api/attachments/${attachmentId}`, { method: 'DELETE' });
  check('DELETE /api/attachments/:id 返回 deleted=true', deletedAttachment.body?.data?.deleted === true);
  const servedAfterDelete = await api(secondUrl ?? '/attachments/none');
  check('删除后附件不可再取回', servedAfterDelete.status === 404, `实际 ${servedAfterDelete.status}`);

  section('静态站点导出');
  // 上传一张会被导出复制的附件，并把冒烟笔记正文改成含嵌入/双链/悬空/裸 HTML 的复合样本
  const expAtt = await api('/api/attachments', {
    method: 'POST',
    body: JSON.stringify({ name: '导出配图.png', mime: 'image/png', data: PNG_B64 }),
  });
  const expAttUrl = expAtt.body?.data?.url;
  await api(`/api/notes/${noteId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      content: [
        '# 导出复合样本',
        `![配图](${expAttUrl})`,
        '链接 [[欢迎使用格物]]，悬空 [[不存在的目标]]。',
        '',
        '![[双向链接是什么]]',
        '',
        '<script>alert(1)</script>',
        '[坏](javascript:alert(1))',
      ].join('\n'),
    }),
  });

  const exp = await api('/api/export/static', { method: 'POST', body: '{}' });
  check('POST /api/export/static 返回 200', exp.status === 200, `实际 ${exp.status}`);
  const site = exp.body?.data ?? {};
  check('导出返回预览入口与统计', typeof site.entry === 'string' && site.entry.startsWith('/export/') && site.noteCount > 0);
  check('导出复制了被引用的附件', (site.attachmentCount ?? 0) >= 1, `实际 ${site.attachmentCount}`);

  const indexRes = await fetch(`${BASE}${site.entry}`);
  const indexHtml = await indexRes.text();
  check('导出的 index.html 可 HTTP 取回', indexRes.status === 200, `实际 ${indexRes.status}`);
  check('首页含站点标题与笔记卡片', indexHtml.includes('格物 · 知识库') && indexHtml.includes('class="card"'));
  check('首页含标签索引锚点', indexHtml.includes('id="tag-'));

  const cssRes = await fetch(`${BASE}/export/${site.run}/assets/style.css`);
  check('导出样式表以 text/css 下发', cssRes.status === 200 && (cssRes.headers.get('content-type') ?? '').includes('text/css'));

  // 直接取回复合样本笔记页，验证链接解析 / 内联 / 附件改写 / 安全转义
  // 文件名由笔记标题（非正文 h1）决定
  const sampleHref = `notes/${encodeURIComponent('冒烟测试笔记')}-${noteId.slice(0, 8)}.html`;
  const pageRes = await fetch(`${BASE}/export/${site.run}/${sampleHref}`);
  const pageHtml = await pageRes.text();
  check('笔记页可 HTTP 取回', pageRes.status === 200, `实际 ${pageRes.status}`);
  check('双链解析为兄弟页相对链接', /<a class="wiki-link" href="欢迎使用格物-[0-9a-f]{8}\.html">/.test(pageHtml));
  check('悬空双链渲染为不可点 span', /<span class="wiki-link is-dangling"/.test(pageHtml));
  check('块级嵌入被内联', /<div class="note-embed">/.test(pageHtml));
  check('附件改写为相对 ../attachments/', new RegExp('<img src="\\.\\./attachments/').test(pageHtml));
  check('裸 <script> 被转义', pageHtml.includes('&lt;script&gt;') && !/<script>alert\(1\)<\/script>/.test(pageHtml));
  check('javascript: 链接被丢弃', !/href="javascript/i.test(pageHtml));
  check('标题生成锚点 id', /<h1 id="/.test(pageHtml));

  section('笔记版本历史');
  // 上面对 noteId 做过多次 PATCH：首条快照诞生于第一次实质改动，
  // 其后改动落在默认 5 分钟节流窗口内被压制，故此处 noteId 恰好有历史。
  const versions = await api(`/api/notes/${noteId}/versions`);
  check('GET /api/notes/:id/versions 返回 200', versions.status === 200, `实际 ${versions.status}`);
  check('版本列表为数组且非空', Array.isArray(versions.body?.data) && versions.body.data.length >= 1);
  const v0 = versions.body?.data?.[0];
  check('版本条目含 id/title/createdAt/size', !!v0 && typeof v0.id === 'string' && typeof v0.size === 'number');
  check('版本列表不返回正文', v0 && v0.content === undefined);

  const oneVer = await api(`/api/notes/${noteId}/versions/${v0.id}`);
  check('GET /api/notes/:id/versions/:versionId 返回 200', oneVer.status === 200, `实际 ${oneVer.status}`);
  check('单条版本返回全文', typeof oneVer.body?.data?.content === 'string' && oneVer.body.data.id === v0.id);

  const ghostVer = await api(`/api/notes/${noteId}/versions/${crypto.randomUUID()}`);
  check('读取不存在的版本返回 404', ghostVer.status === 404, `实际 ${ghostVer.status}`);
  const missingOwner = await api(`/api/notes/${crypto.randomUUID()}/versions`);
  check('笔记不存在时列表返回 404', missingOwner.status === 404, `实际 ${missingOwner.status}`);
  const badVerUuid = await api('/api/notes/not-a-uuid/versions');
  check('非法笔记 UUID 的版本路由返回 422', badVerUuid.status === 422, `实际 ${badVerUuid.status}`);

  const restoreRes = await api(`/api/notes/${noteId}/versions/${v0.id}/restore`, { method: 'POST', body: '{}' });
  check('POST /api/notes/:id/versions/:versionId/restore 返回 200', restoreRes.status === 200, `实际 ${restoreRes.status}`);
  check('恢复响应带回当前笔记与来源版本', restoreRes.body?.data?.note?.id === noteId && restoreRes.body?.data?.restoredFrom === v0.id);
  const afterRestore = await api(`/api/notes/${noteId}`);
  check('恢复后正文等于所选版本', afterRestore.body?.data?.content === oneVer.body?.data?.content);
  const versionsAfter = await api(`/api/notes/${noteId}/versions`);
  check('恢复会先快照旧态（历史增加且可再次撤销）', versionsAfter.body.data.length === versions.body.data.length + 1,
    `${versions.body.data.length} → ${versionsAfter.body.data.length}`);

  section('PWA 资产与外壳');
  // 仅在已构建前端（web/dist 存在）时，后端才托管这些；未构建则整体跳过，不误报。
  const shell = await api('/');
  const shellIsApp = shell.status === 200 && typeof shell.body === 'string' && shell.body.includes('<div id="root">');
  if (!shellIsApp) {
    console.log('  \x1b[33m·\x1b[0m 前端未构建，跳过 PWA 托管检查（先 npm run build 再复测）');
  } else {
    check('GET / 返回应用外壳', shell.status === 200);
    check('外壳声明了 manifest 链接', /rel="manifest"/.test(shell.body) && shell.body.includes('manifest.webmanifest'));
    check('外壳带 theme-color', /name="theme-color"/.test(shell.body));
    check(
      '外壳仍受 script-src \'self\' CSP 约束（PWA 未削弱安全头）',
      (shell.headers.get('content-security-policy') || '').includes("script-src 'self'"),
      shell.headers.get('content-security-policy') ?? '（无 CSP）',
    );

    const manifest = await api('/manifest.webmanifest');
    check('GET /manifest.webmanifest 返回 200', manifest.status === 200, `实际 ${manifest.status}`);
    check(
      '清单以 application/manifest+json 下发',
      (manifest.headers.get('content-type') || '').includes('application/manifest+json'),
      `实际 ${manifest.headers.get('content-type')}`,
    );
    check('清单可解析且含安装必需字段', (() => {
      try {
        const json = typeof manifest.body === 'string' ? JSON.parse(manifest.body) : manifest.body;
        return Boolean(json.name && json.start_url && json.display === 'standalone' && Array.isArray(json.icons) && json.icons.length >= 1);
      } catch {
        return false;
      }
    })());

    const sw = await api('/sw.js');
    check('GET /sw.js 返回 200', sw.status === 200, `实际 ${sw.status}`);
    check('SW 以 JS 类型下发（非回退成 HTML）', (sw.headers.get('content-type') || '').includes('javascript'), `实际 ${sw.headers.get('content-type')}`);
    check('SW 源码含缓存策略关键字', typeof sw.body === 'string' && sw.body.includes('addEventListener') && sw.body.includes('fetch'));

    const icon = await api('/pwa-512.png');
    check('GET /pwa-512.png 以 image/png 下发', icon.status === 200 && (icon.headers.get('content-type') || '').includes('image/png'));

    // 未知客户端路由仍回退到外壳（SPA 深链在离线时可被 SW 命中）
    const deep = await api('/notes/deeplink-not-an-api');
    check('未知前端路由回退到外壳', deep.status === 200 && typeof deep.body === 'string' && deep.body.includes('<div id="root">'));
  }

  section('清理');
  const deleted = await api(`/api/notes/${noteId}`, { method: 'DELETE' });
  check('DELETE /api/notes/:id 返回 200', deleted.status === 200);
  check('删除返回 deleted=true', deleted.body?.data?.deleted === true);
  const deletedAgain = await api(`/api/notes/${noteId}`, { method: 'DELETE' });
  check('重复删除幂等（不报错）', deletedAgain.status === 200 && deletedAgain.body?.data?.deleted === false);
  const deletedFolder = await api(`/api/folders/${folderId}`, { method: 'DELETE' });
  check('DELETE /api/folders/:id 返回 200', deletedFolder.status === 200);

  console.log(`\n${'─'.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m全部通过：${passed} 项检查\x1b[0m\n`);
  } else {
    console.log(`\x1b[31m失败 ${failures.length} 项 / 通过 ${passed} 项\x1b[0m`);
    for (const failure of failures) console.log(`  · ${failure}`);
    console.log('');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\n\x1b[31m冒烟测试无法执行：${error.message}\x1b[0m`);
  console.error('请确认后端已启动：npm run dev:server');
  process.exit(1);
});
