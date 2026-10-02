#!/usr/bin/env node

const rootUrl = (process.env.LATTICE_BASE_URL ?? 'http://127.0.0.1:5177').replace(/\/+$/, '');
const apiUrl = `${rootUrl}/api`;
const accessToken = process.env.LATTICE_AI_ACCESS_TOKEN?.trim() ?? '';
const workspaceToken = process.env.LATTICE_WORKSPACE_ACCESS_TOKEN?.trim() || accessToken;
const aiHeaders = {
  Accept: 'application/json',
  ...(workspaceToken ? { 'X-Workspace-Token': workspaceToken } : {}),
  ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
};

let passed = 0;
let failed = 0;

console.log(`\nAPI 冒烟测试 → ${rootUrl}`);

await check('健康探针', `${rootUrl}/health`);
const notes = await check('笔记索引', `${apiUrl}/notes/index`);
await check('目录树', `${apiUrl}/folders`);
await check('标签列表', `${apiUrl}/tags`);
await check('全文检索', `${apiUrl}/search?q=${encodeURIComponent('笔记')}`);
await check('关系图谱', `${apiUrl}/graph`);
await check('知识库概览', `${apiUrl}/meta/overview`);
await check('白板文件列表', `${apiUrl}/canvas/files`);
await check('Vault 资源列表', `${apiUrl}/vault/assets`);

const context = {
  files: Array.isArray(notes?.data) ? notes.data.slice(0, 20) : [],
  folders: [],
};
await check('AI 本地对话', `${apiUrl}/ai/chat`, {
  method: 'POST',
  headers: { ...aiHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: '整理当前 Vault 的文件', context, actor: 'smoke-test', role: 'editor' }),
});
await check('AI 只读操作预览', `${apiUrl}/ai/operations/preview`, {
  method: 'POST',
  headers: { ...aiHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ actions: [{ type: 'read', path: 'smoke-missing.md' }], actor: 'smoke-test', role: 'viewer' }),
});
await check('AI 路径越界被拒绝', `${apiUrl}/ai/operations/preview`, {
  expectedStatus: 422,
  method: 'POST',
  headers: { ...aiHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ actions: [{ type: 'read', path: '../outside.md' }], actor: 'smoke-test', role: 'viewer' }),
});
await check('AI 审计历史', `${apiUrl}/ai/history?limit=5`, { headers: aiHeaders });

console.log(`\n${'─'.repeat(56)}`);
if (failed) {
  console.log(`失败 ${failed} 项 / 通过 ${passed} 项`);
  process.exitCode = 1;
} else {
  console.log(`全部通过：${passed} 项检查`);
}

async function check(label, url, options = {}) {
  try {
    const response = await fetch(url, options);
    const expectedStatus = options.expectedStatus ?? 200;
    const body = await response.json().catch(() => null);
    if (response.status !== expectedStatus) {
      failed += 1;
      console.log(`  ✗ ${label}（HTTP ${response.status}，预期 ${expectedStatus}）`);
      return body;
    }
    passed += 1;
    console.log(`  ✓ ${label}`);
    return body;
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${label}（${error.message}）`);
    return null;
  }
}
