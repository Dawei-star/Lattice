'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyPackage } = require('../build/verify-package.cjs');

function makePackage({
  route = true,
  client = true,
  pwa = true,
  marketRef = true,
  marketLogo = true,
  experts = true,
  skills = true,
  skillBody = true,
  mcpServer = true,
  sdk = true,
  review = true,
  reviewCategories = true,
  sessionExpert = true,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-package-'));
  const routeDir = path.join(root, 'server', 'src', 'modules', 'canvas');
  const assetsDir = path.join(root, 'web', 'assets');
  fs.mkdirSync(routeDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(routeDir, 'canvas.routes.js'), route ? "canvasRouter.get('/files', controller.listCanvasFiles);" : 'canvasRouter.get(\'/\', controller.readCanvas);');
  fs.writeFileSync(path.join(routeDir, 'canvas.controller.js'), 'export function listCanvasFiles() {}');
  // bundle 里模拟市场卡片对品牌 logo 的引用：真实产物是**模板拼字符串**
  // （`LOGO = (n) => "/mcp-logos/" + n + ".svg"`）+ 市场 id 前缀，不含完整 logo 字面量。
  const marketRefSrc = marketRef
    ? 'const ID="mcp-market-";const LOGO=(n)=>"/mcp-logos/"+n+".svg";'
    : '';
  fs.writeFileSync(
    path.join(assetsDir, 'index.js'),
    `${client ? 'fetch("/canvas/files");' : 'fetch("/canvas");'}${marketRefSrc}`,
  );
  // verifyPackage 还要求 PWA 静态资源随包发出（web/public 会被 vite 拷进 web/dist 根）。
  if (pwa) {
    fs.writeFileSync(path.join(root, 'web', 'sw.js'), 'self.addEventListener("install", () => {});');
    fs.writeFileSync(path.join(root, 'web', 'manifest.webmanifest'), '{"name":"Lattice"}');
  }
  // …以及市场目录引用到的每个 /mcp-logos/*.svg。
  if (marketLogo) {
    const logoDir = path.join(root, 'web', 'mcp-logos');
    fs.mkdirSync(logoDir, { recursive: true });
    fs.writeFileSync(path.join(logoDir, 'mcp.svg'), '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="#000000"/></svg>');
  }
  fs.writeFileSync(
    path.join(root, 'web', 'index.html'),
    pwa ? '<link rel="manifest" href="/manifest.webmanifest" /><div id="root"></div>' : '<div id="root"></div>',
  );
  // 内置专家 / Skill 是运行时数据文件（experts.registry 静默吞掉读取异常，缺文件不报错）。
  const builtinDir = path.join(root, 'server', 'src', 'modules', 'experts', 'builtin');
  if (experts) {
    fs.mkdirSync(path.join(builtinDir, 'experts'), { recursive: true });
    fs.writeFileSync(
      path.join(builtinDir, 'experts', 'general.json'),
      JSON.stringify({ id: 'general', name: '通用', skills: [{ id: 'vault-search' }] }),
    );
  }
  if (skills) {
    const skillDir = path.join(builtinDir, 'skills', 'vault-search');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({ id: 'vault-search', name: '库内检索' }));
    if (skillBody) fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# 库内检索\n');
  }
  // scripts/mcp-server 与 app 根 node_modules 的 @modelcontextprotocol/sdk。
  if (mcpServer) {
    const mcpDir = path.join(root, 'scripts', 'mcp-server');
    fs.mkdirSync(path.join(mcpDir, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    fs.writeFileSync(path.join(mcpDir, 'server.mjs'), '// stdio MCP server');
    fs.writeFileSync(path.join(mcpDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{"name":"@modelcontextprotocol/sdk"}');
  }
  if (sdk) {
    const sdkDir = path.join(root, 'node_modules', '@modelcontextprotocol', 'sdk');
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(path.join(sdkDir, 'package.json'), '{"name":"@modelcontextprotocol/sdk"}');
  }
  // 知识健康中心（review 模块）：前端按固定 key 渲染 6 张卡片，缺键=静默少一块面板。
  if (review) {
    const reviewDir = path.join(root, 'server', 'src', 'modules', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'review.routes.js'), "reviewRouter.get('/health', controller.getHealth);");
    fs.writeFileSync(path.join(reviewDir, 'review.controller.js'), 'export function getHealth() {}');
    const keys = ['inbox', 'brokenLinks', 'isolated', 'stale', 'duplicates'];
    if (reviewCategories) keys.push('incomplete');
    // 真实源码用的是 ES6 简写 `const categories = { inbox, brokenLinks, ... }`，
    // 没有 `inbox:` 这种字面量 —— fixture 必须照抄，否则测的是个不存在的形态。
    fs.writeFileSync(
      path.join(reviewDir, 'knowledge-health.service.js'),
      `const a=1,b=2,c=3,d=4,e=5,f=6;\n`
      + `export function scan() { const categories = { ${keys.join(', ')} }; return { categories }; }`,
    );
  }
  // AI 会话按专家隔离：迁移 007 建列 + listSessionPage 导出 + controller 回 meta。
  if (sessionExpert) {
    const aiDir = path.join(root, 'server', 'src', 'modules', 'ai');
    fs.mkdirSync(aiDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'server', 'src', 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'server', 'src', 'migrations', '007_ai_session_expert.sql'),
      'ALTER TABLE ai_sessions ADD COLUMN expert_id TEXT NOT NULL DEFAULT \'general\';\n',
    );
    fs.writeFileSync(
      path.join(aiDir, 'ai.sessions.js'),
      "export function listSessionPage({ limit = 50, offset = 0, expertId = 'general' } = {}) {\n"
      + "  const where = ['expert_id = ?'];\n"
      + '  return { items: [], total: 0, limit, offset, hasMore: false };\n'
      + '}\n',
    );
    fs.writeFileSync(
      path.join(aiDir, 'ai.controller.js'),
      'export function listSessions(req, res) {\n'
      + '  const page = sessions.listSessionPage(req.valid.query);\n'
      + '  res.json({ data: page.items, meta: { total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore } });\n'
      + '}\n',
    );
  }
  return root;
}

test('package contract accepts matching canvas client and server artifacts', (t) => {
  const root = makePackage();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.doesNotThrow(() => verifyPackage(root));
});

test('package contract rejects an artifact with the canvas list route missing', (t) => {
  const root = makePackage({ route: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /does not provide GET \/api\/canvas\/files/);
});

test('package contract rejects an artifact with the canvas client missing', (t) => {
  const root = makePackage({ client: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /does not include the canvas file-list API contract/);
});

test('package contract rejects an artifact with PWA assets missing', (t) => {
  const root = makePackage({ pwa: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /missing PWA assets/);
});

test('package contract rejects an artifact whose marketplace logos were never shipped', (t) => {
  const root = makePackage({ marketLogo: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /has no \.svg logos/);
});

test('package contract rejects an artifact built without the marketplace in the bundle', (t) => {
  const root = makePackage({ marketRef: false, marketLogo: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /does not include the MCP marketplace/);
});

test('package contract rejects an artifact whose builtin experts were never shipped', (t) => {
  const root = makePackage({ experts: false, skills: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /has no expert definitions/);
});

test('package contract rejects a builtin skill directory missing SKILL.md', (t) => {
  const root = makePackage({ skillBody: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /builtin skills are incomplete: vault-search\/SKILL\.md/);
});

test('package contract rejects an expert bound to a skill that is not packaged', (t) => {
  const root = makePackage({ skills: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /bind skills that are not packaged: general → vault-search/);
});

test('package contract rejects an artifact missing the app-root MCP SDK (ai.mcp.js bare import)', (t) => {
  const root = makePackage({ sdk: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /missing @modelcontextprotocol\/sdk/);
});

test('package contract rejects an artifact missing the packaged MCP server', (t) => {
  const root = makePackage({ mcpServer: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /missing scripts\/mcp-server\/server\.mjs/);
});

test('package contract rejects an artifact missing the knowledge-health review module', (t) => {
  const root = makePackage({ review: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /modules\/review is missing: review\.routes\.js/);
});

test('package contract rejects a knowledge-health service that dropped a category', (t) => {
  const root = makePackage({ reviewCategories: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /no longer builds these categories: incomplete/);
});

test('package contract rejects an artifact missing the AI session expert isolation chain', (t) => {
  const root = makePackage({ sessionExpert: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyPackage(root), /007_ai_session_expert\.sql is missing/);
});

test('package contract rejects sessions that no longer filter by expert_id', (t) => {
  const root = makePackage();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'server', 'src', 'modules', 'ai', 'ai.sessions.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("['expert_id = ?']", "['1 = 1']"));
  assert.throws(() => verifyPackage(root), /no longer filters sessions by expert_id/);
});

test('package contract rejects a session controller that dropped the pagination meta', (t) => {
  const root = makePackage();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'server', 'src', 'modules', 'ai', 'ai.controller.js');
  // 把 meta 换成裸数组响应：分页元数据整段消失。
  fs.writeFileSync(
    file,
    'export function listSessions(req, res) {\n'
    + '  const page = sessions.listSessionPage(req.valid.query);\n'
    + '  res.json({ data: page.items });\n'
    + '}\n',
  );
  assert.throws(() => verifyPackage(root), /no longer returns the pagination meta/);
});
