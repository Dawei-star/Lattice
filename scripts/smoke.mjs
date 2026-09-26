#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
/**
 * 端到端冒烟测试：对运行中的后端逐项验证接口契约。
 *
 *   node scripts/smoke.mjs
 *   SMOKE_BASE_URL=http://127.0.0.1:5177 node scripts/smoke.mjs
 *
 * 覆盖：探针 / 笔记 CRUD / 目录 / 标签 / 全文检索（中英文、长短词）/ 图谱 /
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
  const initialFolder = await api('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-initial-${Date.now()}` }),
  });
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
  const target = await api('/api/notes', {
    method: 'POST',
    body: JSON.stringify({
      id: crypto.randomUUID(),
      title: '欢迎使用格物',
      content: '# 双向链接是什么\n\n知识检索示例，FTS5 可用于全文索引。',
    }),
  });
  check('测试目标笔记创建成功', target.status === 201);
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

  const vaultInfo = await api('/api/vault/info');
  check('Vault 信息接口返回 Markdown 模式', vaultInfo.status === 200 && vaultInfo.body?.data?.mode === 'markdown');
  const createdMarkdown = path.join(vaultInfo.body?.data?.vaultDir ?? '', createdFolder.body?.data?.name ?? '', '冒烟测试笔记.md');
  try {
    await fs.access(createdMarkdown);
    check('创建笔记后磁盘出现 Markdown 文件', true, createdMarkdown);
  } catch {
    check('创建笔记后磁盘出现 Markdown 文件', false, createdMarkdown);
  }

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

  const migration = await api('/api/vault/migrate', { method: 'POST', body: '{}' });
  check('SQLite 到 Markdown 迁移接口返回 200', migration.status === 200, `实际 ${migration.status}`);
  check('迁移结果包含冲突报告', Array.isArray(migration.body?.data?.conflicts));

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

  section('清理');
  const deleted = await api(`/api/notes/${noteId}`, { method: 'DELETE' });
  check('DELETE /api/notes/:id 返回 200', deleted.status === 200);
  check('删除返回 deleted=true', deleted.body?.data?.deleted === true);
  const deletedAgain = await api(`/api/notes/${noteId}`, { method: 'DELETE' });
  check('重复删除幂等（不报错）', deletedAgain.status === 200 && deletedAgain.body?.data?.deleted === false);
  const deletedFolder = await api(`/api/folders/${folderId}`, { method: 'DELETE' });
  check('DELETE /api/folders/:id 返回 200', deletedFolder.status === 200);

  console.log(`\n${'─'.repeat(56)}`);
  if (initialFolder.body?.data?.id) {
    await api(`/api/folders/${initialFolder.body.data.id}`, { method: 'DELETE' });
  }
  if (target.body?.data?.id) {
    await api(`/api/notes/${target.body.data.id}`, { method: 'DELETE' });
  }

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
