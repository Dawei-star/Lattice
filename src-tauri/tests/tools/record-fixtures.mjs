#!/usr/bin/env node
/**
 * P1-08 功能对齐验证 · 第 1 步：为每个 Express 端点录制真实请求/响应快照。
 *
 * 产出（每次运行覆盖式重写 `src-tauri/tests/fixtures/`）：
 *   seed/vault/**        确定性 Vault 快照（可见用户文件，文本内 ISO 时间戳已归一）
 *   seed/manifest.json   播种实体清单（notes/folders/tags/canvas/attachments/experts/skills）
 *   cases/<command>.json 每个 Rust 命令一个 case（Express 侧有对应端点者）
 *   index.json           全部 case 索引、覆盖统计与跳过明细
 *
 * 运行：node src-tauri/tests/tools/record-fixtures.mjs
 * 失败即非 0 退出；所有产物先收集，成功后再落盘。
 *
 * 边界：不修改 server/、src-tauri/src/、web/src/、web/test/；只写本工具与 fixtures。
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOLS_DIR, '..', '..', '..');
const FIXTURES_DIR = path.resolve(TOOLS_DIR, '..', 'fixtures');

/** undici（Node fetch）拒绝连接的端口；必须与 web/test/run-integration.mjs 一致。 */
const BLOCKED_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** 播种时显式指定的实体 id —— 这些是跨通道对齐的锚点，归一化时必须原样保留。 */
const ID = Object.freeze({
  noteAlpha: 'f1a00000-0000-4000-8000-000000000011',
  noteBeta: 'f1a00000-0000-4000-8000-000000000012',
  noteMoved: 'f1a00000-0000-4000-8000-000000000013',
  noteDelete: 'f1a00000-0000-4000-8000-000000000014',
  noteNew: 'f1a00000-0000-4000-8000-000000000015',
  expert: 'fix-expert',
  expertTwo: 'fix-expert-two',
  skill: 'fix-skill',
  skillTwo: 'fix-skill-two',
});
const SEED_IDS = new Set(Object.values(ID));

/** 归一化期间需要替换的运行期前缀（在 main 里赋值）。 */
const RUNTIME = { vaultDir: '', tempRoot: '' };

// ─────────────────────────────── 归一化 ───────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/i;
const HISTORY_VERSION_RE = /^\d{8}T\d{9}Z-[0-9a-f]{64}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ISO_GLOBAL_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gi;
const UUID_GLOBAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HASH_GLOBAL_RE = /[0-9a-f]{64}/gi;
const HISTORY_VERSION_GLOBAL_RE = /\d{8}T\d{9}Z-[0-9a-f]{64}/gi;
/** fc-core 的 operationId：`<epochMs>-<8 hex>`。 */
const OPERATION_ID_RE = /^\d{13}-[0-9a-f]{8}$/i;
const OPERATION_ID_GLOBAL_RE = /\d{13}-[0-9a-f]{8}/gi;

const TIME_KEYS = new Set([
  'createdAt', 'updatedAt', 'modifiedAt', 'scannedAt', 'expiresAt',
  'startedAt', 'finishedAt', 'recordedAt', 'generatedAt', 'deletedAt', 'at', 'timestamp',
]);
const DURATION_KEYS = new Set(['durationMs', 'tookMs', 'elapsedMs', 'duration']);

/** 用占位符替换易变子串；返回新串并标记是否发生变化。 */
function replaceAllPlaceholder(value, regex, placeholder) {
  const next = value.replace(regex, placeholder);
  return { value: next, changed: next !== value };
}

/**
 * 单值字符串归一化。返回替换后的字符串，并把发生替换的 JSONPath 记进 volatilePaths。
 * 同时处理「整串即一个易变 token」与「token 内嵌于更长文本（如文件路径、Markdown 正文）」两种形态。
 */
function normalizeString(value, jsonPath, volatilePaths) {
  if (HISTORY_VERSION_RE.test(value)) {
    volatilePaths.push(jsonPath);
    return '<version>';
  }
  if (OPERATION_ID_RE.test(value)) {
    volatilePaths.push(jsonPath);
    return '<operationId>';
  }
  if (HASH_RE.test(value)) {
    volatilePaths.push(jsonPath);
    return '<hash>';
  }
  if (ISO_RE.test(value)) {
    volatilePaths.push(jsonPath);
    return '<timestamp>';
  }
  if (UUID_RE.test(value) && !SEED_IDS.has(value)) {
    volatilePaths.push(jsonPath);
    return '<uuid>';
  }

  let next = value;
  let changed = false;
  for (const [regex, placeholder] of [
    [HISTORY_VERSION_GLOBAL_RE, '<version>'],
    [OPERATION_ID_GLOBAL_RE, '<operationId>'],
    [ISO_GLOBAL_RE, '<timestamp>'],
    [HASH_GLOBAL_RE, '<hash>'],
  ]) {
    const replaced = replaceAllPlaceholder(next, regex, placeholder);
    if (replaced.changed) {
      changed = true;
      next = replaced.value;
    }
  }
  next = next.replace(UUID_GLOBAL_RE, (match) => {
    if (SEED_IDS.has(match)) return match;
    changed = true;
    return '<uuid>';
  });

  if (RUNTIME.vaultDir && next.includes(RUNTIME.vaultDir)) {
    next = next.split(RUNTIME.vaultDir).join('<vault>');
    changed = true;
  }
  if (RUNTIME.tempRoot && next.includes(RUNTIME.tempRoot)) {
    next = next.split(RUNTIME.tempRoot).join('<vault>');
    changed = true;
  }
  if (PROJECT_ROOT && next.includes(PROJECT_ROOT)) {
    next = next.split(PROJECT_ROOT).join('<repo>');
    changed = true;
  }
  if (changed) volatilePaths.push(jsonPath);
  return next;
}

/** 递归归一：替换易变值 → 占位符，并把路径记入 volatilePaths。 */
function normalizeValue(value, jsonPath, volatilePaths) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeValue(item, `${jsonPath}[${index}]`, volatilePaths));
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${jsonPath}.${key}`;
      if (typeof item === 'string' && TIME_KEYS.has(key)) {
        volatilePaths.push(childPath);
        result[key] = '<timestamp>';
        continue;
      }
      if (typeof item === 'number' && DURATION_KEYS.has(key)) {
        volatilePaths.push(childPath);
        result[key] = 0;
        continue;
      }
      result[key] = normalizeValue(item, childPath, volatilePaths);
    }
    return result;
  }
  if (typeof value === 'string') return normalizeString(value, jsonPath, volatilePaths);
  return value;
}

/** 结构描述：对象按实际出现的键递归；数组记录首元素 schema 与原始长度。 */
function schemaOf(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return { type: 'array', element: value.length ? schemaOf(value[0]) : null, length: value.length };
  }
  if (typeof value === 'object') {
    const fields = {};
    for (const [key, item] of Object.entries(value)) fields[key] = schemaOf(item);
    return { type: 'object', fields };
  }
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: typeof value };
}

// ─────────────────────────────── HTTP ───────────────────────────────

async function request(ctx, method, pathname, { query, body, raw, contentType } = {}) {
  const url = new URL(`${ctx.baseUrl}${pathname}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const init = { method, headers: {} };
  if (raw !== undefined) {
    init.body = raw;
    init.headers['Content-Type'] = contentType ?? 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, init);
  const buffer = Buffer.from(await response.arrayBuffer());
  const responseType = response.headers.get('content-type') ?? '';
  let json = null;
  if (responseType.includes('application/json')) {
    try {
      json = JSON.parse(buffer.toString('utf8'));
    } catch {
      json = null;
    }
  }
  return { status: response.status, buffer, json, contentType: responseType };
}

/** 播种/隐蔽准备用的调用：非 2xx 直接抛错，返回 data 信封。 */
async function expectData(ctx, method, pathname, options, label) {
  const response = await request(ctx, method, pathname, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label} 失败：HTTP ${response.status} ${describeBody(response)}`);
  }
  if (!response.json || !Object.prototype.hasOwnProperty.call(response.json, 'data')) {
    throw new Error(`${label} 未返回 data 信封：${describeBody(response)}`);
  }
  return response.json.data;
}

function describeBody(response) {
  if (response.json) return JSON.stringify(response.json).slice(0, 400);
  return response.buffer.toString('utf8').slice(0, 400);
}

// ─────────────────────────────── 播种 ───────────────────────────────

// 注意：行首的 `#标签` 会被服务端 heading 启发式吃掉，标签需内联在文字之后。
const ALPHA_CONTENT = 'Alpha 的正文\n\n标签 #tag-alpha\n\n引用 [[Beta 笔记]]\n';
const ALPHA_UPDATED_CONTENT = 'Alpha 的正文（已更新）\n\n标签 #tag-alpha\n';
const BETA_CONTENT = 'Beta 的正文\n\n![[attachments/att-referenced.txt]]\n\n标签 #tag-beta\n';
const MOVED_CONTENT = '待移动的正文\n';
const DELETE_CONTENT = '待删除的正文 标签 #tag-archive\n';
const SEED_CANVAS_PATH = 'seed-canvas.canvas';

async function seed(ctx) {
  const seed = ctx.seed;

  // 目录：项目（根） + 归档（项目/归档）
  const project = await expectData(ctx, 'POST', '/api/folders', {
    body: { name: '项目', parentId: null, sortOrder: 0, confirmed: true },
  }, 'seed folder 项目');
  seed.folders = [{ ...project }];
  const archive = await expectData(ctx, 'POST', '/api/folders', {
    body: { name: '归档', parentId: project.id, sortOrder: 0, confirmed: true },
  }, 'seed folder 归档');
  seed.folders.push({ ...archive });

  // 附件：被引用的附件（供 references/cleanup 用例）
  const referenced = await expectData(ctx, 'POST', '/api/vault/attachments', {
    query: { name: 'att-referenced.txt', confirmed: 'true' },
    raw: 'referenced fixture\n',
    contentType: 'text/plain',
  }, 'seed attachment att-referenced.txt');
  seed.attachments = [{ ...referenced }];

  // 笔记
  seed.notes = [];
  seed.notes.push(await createNote(ctx, {
    id: ID.noteAlpha, title: 'Alpha 笔记', content: ALPHA_CONTENT, folderId: null,
    properties: { type: 'inbox', status: 'captured' },
  }));
  seed.notes.push(await createNote(ctx, {
    id: ID.noteBeta, title: 'Beta 笔记', content: BETA_CONTENT, folderId: project.id, properties: {},
  }));
  seed.notes.push(await createNote(ctx, {
    id: ID.noteMoved, title: '待移动笔记', content: MOVED_CONTENT, folderId: null, properties: {},
  }));
  seed.notes.push(await createNote(ctx, {
    id: ID.noteDelete, title: '待删除笔记', content: DELETE_CONTENT, folderId: archive.id, properties: {},
  }));

  // 画布
  await expectData(ctx, 'PUT', '/api/canvas/', {
    query: { path: SEED_CANVAS_PATH },
    body: {
      nodes: [{ id: 'seed-node-1', type: 'text', text: '种子节点', x: 0, y: 0, width: 200, height: 100 }],
      edges: [],
      confirmed: true,
    },
  }, 'seed canvas');
  seed.canvas = [{ path: SEED_CANVAS_PATH }];

  // 专家 + 技能
  seed.skills = [await expectData(ctx, 'POST', '/api/experts/skills', {
    body: {
      id: ID.skill, name: '固定技能', description: '固定技能描述', content: '这是固定技能内容',
      triggers: ['固定'], tools: ['read'], permissions: ['read'], enabled: true, confirmed: true,
    },
  }, 'seed skill')];
  seed.experts = [await expectData(ctx, 'POST', '/api/experts', {
    body: {
      id: ID.expert, name: '固定专家', description: '固定专家描述', icon: 'sparkles', enabled: true,
      systemPrompt: '你是固定专家', scope: { include: ['固定'], exclude: [] },
      skills: [{ id: ID.skill, enabled: true, priority: 60, config: {} }],
      routing: { keywords: ['固定', '专家'], priority: 80, confidenceThreshold: 0.5 },
      confirmed: true,
    },
  }, 'seed expert')];

  // 标签（由笔记正文派生，读取当前全量）
  seed.tags = await expectData(ctx, 'GET', '/api/tags', {}, 'seed tags');
}

function createNote(ctx, { id, title, content, folderId, properties }) {
  return expectData(ctx, 'POST', '/api/notes', {
    body: { id, title, content, folderId, properties, confirmed: true },
  }, `seed note ${id}`);
}

// ─────────────────────────────── 录制 ───────────────────────────────

/** 录制单个 case：返回归一后的 caseObject 与未归一 rawData（供后续请求复用运行期 id）。 */
function recordCase(ctx, { domain, command, method, path: pathname, query, body, raw, contentType, binary, note }) {
  return (async () => {
    const response = await request(ctx, method, pathname, { query, body, raw, contentType });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`[${command}] ${method} ${pathname} 返回 HTTP ${response.status}：${describeBody(response)}`);
    }
    let data;
    if (binary) {
      data = response.buffer.toString('base64');
    } else {
      if (!response.json) {
        throw new Error(`[${command}] 期望 JSON 响应却收到 ${response.contentType || '未知类型'}`);
      }
      data = Object.prototype.hasOwnProperty.call(response.json, 'data') ? response.json.data : response.json;
    }

    const volatilePaths = [];
    const http = {
      method,
      path: pathname,
      query: query ? { ...query } : {},
      body: body === undefined ? null : body,
      status: response.status,
    };
    const normalizedHttp = normalizeValue(http, '$.http', volatilePaths);
    const normalizedData = normalizeValue(data, '$.data', volatilePaths);
    const caseObject = {
      command,
      http: normalizedHttp,
      data: normalizedData,
      schema: schemaOf(normalizedData),
      volatilePaths,
    };
    if (note) caseObject.note = note;
    return { domain, caseObject, rawData: data };
  })();
}

async function recordAll(ctx) {
  const state = {};
  const results = [];
  const push = async (descriptor) => {
    const record = await recordCase(ctx, descriptor);
    results.push({ domain: record.domain, caseObject: record.caseObject });
    return record;
  };

  // ── vault（10）
  await push({ domain: 'vault', command: 'vault_info', method: 'GET', path: '/api/vault/info' });

  await push({
    domain: 'vault', command: 'vault_attachment_upload', method: 'POST', path: '/api/vault/attachments',
    query: { name: 'att-fixture.txt', confirmed: 'true' }, raw: 'attachment fixture\n', contentType: 'text/plain',
    note: 'raw 请求体；query 携带 name/confirmed。命令侧参数改为字节数组。',
  });

  await push({ domain: 'vault', command: 'vault_attachments_list', method: 'GET', path: '/api/vault/attachments' });
  await push({ domain: 'vault', command: 'vault_files_list', method: 'GET', path: '/api/vault/files' });
  await push({
    domain: 'vault', command: 'vault_attachment_references', method: 'GET', path: '/api/vault/attachments/references',
    query: { path: 'attachments/att-referenced.txt' },
  });
  await push({
    domain: 'vault', command: 'vault_attachment_validate', method: 'POST', path: '/api/vault/attachments/validate',
    body: {
      content: '引用 ![[attachments/att-referenced.txt]] 与 ![[attachments/missing.txt]]\n',
      filePath: 'Alpha 笔记.md',
    },
  });
  await push({
    domain: 'vault', command: 'vault_attachment_cleanup', method: 'POST', path: '/api/vault/attachments/cleanup',
    body: { dryRun: true }, note: 'dryRun=true，不触发破坏性确认；命令默认 dryRun=true。',
  });
  await push({
    domain: 'vault', command: 'vault_read_asset', method: 'GET', path: '/api/vault/attachment',
    query: { path: 'attachments/att-fixture.txt' }, binary: true,
    note: '二进制响应；data 为 base64 原文。命令 vault_read_asset 亦返回 base64。',
  });
  await push({
    domain: 'vault', command: 'vault_download', method: 'GET', path: '/api/vault/download',
    query: { path: 'attachments/att-fixture.txt' }, binary: true,
    note: '二进制下载；data 为 base64 原文。',
  });
  await push({
    domain: 'vault', command: 'vault_attachment_delete', method: 'DELETE', path: '/api/vault/attachments',
    query: { path: 'attachments/att-fixture.txt', confirmed: 'true', secondConfirmed: 'true' },
  });

  // ── notes（7）
  await push({ domain: 'notes', command: 'note_index', method: 'GET', path: '/api/notes/index', note: 'Express 同时返回 propertiesJson(string) 与 properties(object)。' });
  await push({
    domain: 'notes', command: 'note_create', method: 'POST', path: '/api/notes',
    body: {
      id: ID.noteNew, title: '新建笔记', content: '新建正文\n', folderId: null, properties: {}, confirmed: true,
    },
    note: '客户端显式提供 id（幂等）。',
  });
  await push({
    domain: 'notes', command: 'note_update', method: 'PATCH', path: `/api/notes/${ID.noteAlpha}`,
    body: { content: ALPHA_UPDATED_CONTENT, confirmed: true },
    note: '改正文（不触发确认闸门）；写前快照供 history 用例。',
  });
  await push({ domain: 'notes', command: 'note_history_list', method: 'GET', path: `/api/notes/${ID.noteAlpha}/history` });
  const alphaHistory = await expectData(ctx, 'GET', `/api/notes/${ID.noteAlpha}/history`, {}, 'read history');
  const alphaVersion = alphaHistory.items[0]?.version;
  if (!alphaVersion) throw new Error('note_history_list 为空，无法录制 note_history_get');
  await push({
    domain: 'notes', command: 'note_history_get', method: 'GET', path: `/api/notes/${ID.noteAlpha}/history/${alphaVersion}`,
  });
  await push({
    domain: 'notes', command: 'note_history_restore', method: 'POST', path: `/api/notes/${ID.noteAlpha}/history/${alphaVersion}/restore`,
    body: { confirmed: true },
  });
  await push({
    domain: 'notes', command: 'note_delete', method: 'DELETE', path: `/api/notes/${ID.noteNew}`,
    body: { confirmed: true, secondConfirmed: true },
  });

  // ── tags / search / graph / meta（4）
  await push({ domain: 'tags', command: 'tag_list', method: 'GET', path: '/api/tags' });
  await push({ domain: 'search', command: 'search_query', method: 'GET', path: '/api/search', query: { q: 'Alpha', limit: 10 }, note: '响应 data 为命中数组，meta.strategy/count 未进 case。' });
  await push({ domain: 'graph', command: 'graph_build', method: 'GET', path: '/api/graph' });
  await push({ domain: 'meta', command: 'meta_overview', method: 'GET', path: '/api/meta/overview' });

  // ── folders（4）
  await push({ domain: 'folders', command: 'folder_tree', method: 'GET', path: '/api/folders' });
  const createdFolder = await push({
    domain: 'folders', command: 'folder_create', method: 'POST', path: '/api/folders',
    body: { name: '新目录', parentId: ctx.seed.folders[0].id, sortOrder: 1, confirmed: true },
    note: '命令 folder_create 收父目录路径 parent_path；Express 收 parentId。',
  });
  state.createdFolderId = createdFolder.rawData.id;
  await push({
    domain: 'folders', command: 'folder_update', method: 'PATCH', path: `/api/folders/${state.createdFolderId}`,
    body: { name: '新目录改名', confirmed: true },
    note: '命令 folder_update 收 new_parent_path 且回全树；Express 收 parentId 且回单节点。',
  });
  await push({
    domain: 'folders', command: 'folder_delete', method: 'DELETE', path: `/api/folders/${state.createdFolderId}`,
    body: { confirmed: true, secondConfirmed: true },
    note: 'Express 回 {deletedFolderCount,affectedNoteCount}；命令侧无 affectedNoteCount。',
  });

  // ── canvas（5）
  await push({ domain: 'canvas', command: 'canvas_list', method: 'GET', path: '/api/canvas/files', note: '命令 canvas_list 回 Vec<String>；Express 回 {path,name,folderPath}。' });
  await push({ domain: 'canvas', command: 'canvas_read', method: 'GET', path: '/api/canvas/', query: { path: SEED_CANVAS_PATH } });
  await push({
    domain: 'canvas', command: 'canvas_write', method: 'PUT', path: '/api/canvas/', query: { path: 'fix-canvas.canvas' },
    body: {
      nodes: [{ id: 'fix-n1', type: 'text', text: '固定画布节点', x: 10, y: 20, width: 160, height: 90 }],
      edges: [], confirmed: true,
    },
    note: '新建画布需 confirmed=true；命令侧 body 拆成 nodes/edges。',
  });
  await push({
    domain: 'canvas', command: 'canvas_move', method: 'PATCH', path: '/api/canvas/file',
    body: { fromPath: 'fix-canvas.canvas', toPath: 'fix-canvas-moved.canvas', confirmed: true },
  });
  await push({
    domain: 'canvas', command: 'canvas_delete', method: 'DELETE', path: '/api/canvas/file',
    query: { path: 'fix-canvas-moved.canvas' }, body: { confirmed: true, secondConfirmed: true },
    note: '确认参数在 body，路径在 query（与 web/src/api/canvas.ts 一致）。',
  });

  // ── files（7）
  await push({ domain: 'files', command: 'file_read', method: 'GET', path: '/api/files/read', query: { path: 'Alpha 笔记.md', offset: 0, limit: 1000 } });
  await push({ domain: 'files', command: 'file_find', method: 'GET', path: '/api/files/find', query: { pattern: '**/*', dir: '项目' }, note: '限制 dir=项目 以避开 .lattice/history 下带时间戳的历史文件。' });
  await push({ domain: 'files', command: 'file_grep', method: 'GET', path: '/api/files/grep', query: { query: 'Beta', dir: '项目', regex: 'false' } });

  const previewAction = { type: 'create', path: 'fixture-preview.txt', content: 'preview fixture\n' };
  await push({
    domain: 'files', command: 'file_preview', method: 'POST', path: '/api/files/preview',
    body: { ...previewAction, confirmed: true },
    note: '命令形参是 action/actions 二态；前端传单个 FileAction。',
  });
  const executeAction = { type: 'create', path: 'fixture-executed.txt', content: 'executed fixture\n' };
  const executePlan = await expectData(ctx, 'POST', '/api/files/preview', { body: { ...executeAction, confirmed: true } }, 'hidden preview for execute');
  const executed = await push({
    domain: 'files', command: 'file_execute', method: 'POST', path: '/api/files/execute',
    body: { ...executeAction, planId: executePlan.plan.id, planHash: executePlan.planHash, confirmed: true },
  });
  state.operationId = executed.rawData.operationId;
  await push({
    domain: 'files', command: 'file_undo', method: 'POST', path: '/api/files/undo',
    body: { operationId: state.operationId, force: false },
  });
  await push({ domain: 'files', command: 'file_log', method: 'GET', path: '/api/files/log', query: { limit: 20 } });

  // ── experts（9）
  await push({ domain: 'experts', command: 'expert_list', method: 'GET', path: '/api/experts' });
  await push({ domain: 'experts', command: 'expert_get', method: 'GET', path: `/api/experts/${ID.expert}` });
  await push({
    domain: 'experts', command: 'expert_save', method: 'POST', path: '/api/experts',
    body: { id: ID.expertTwo, name: '固定专家二', description: '第二个固定专家', icon: 'sparkles', enabled: true, confirmed: true },
  });
  await push({
    domain: 'experts', command: 'expert_delete', method: 'DELETE', path: `/api/experts/${ID.expertTwo}`,
    body: { confirmed: true, secondConfirmed: true },
  });
  await push({
    domain: 'experts', command: 'expert_route', method: 'POST', path: '/api/experts/route',
    body: { message: '固定专家请回答' },
  });
  await push({ domain: 'experts', command: 'skill_list', method: 'GET', path: '/api/experts/skills' });
  await push({ domain: 'experts', command: 'skill_get', method: 'GET', path: `/api/experts/skills/${ID.skill}` });
  await push({
    domain: 'experts', command: 'skill_save', method: 'POST', path: '/api/experts/skills',
    body: { id: ID.skillTwo, name: '固定技能二', description: '第二个固定技能', content: '第二个固定技能内容', enabled: true, confirmed: true },
  });
  await push({
    domain: 'experts', command: 'skill_delete', method: 'DELETE', path: `/api/experts/skills/${ID.skillTwo}`,
    body: { confirmed: true, secondConfirmed: true },
  });

  // ── review（3）
  await push({ domain: 'review', command: 'review_health', method: 'GET', path: '/api/review/health', query: { staleDays: 90, limit: 100 } });
  const reviewPlan = await push({
    domain: 'review', command: 'review_plan', method: 'POST', path: '/api/review/health/plan',
    body: { findingIds: [ID.noteAlpha], staleDays: 90, limit: 100 },
  });
  state.planId = reviewPlan.rawData.id;
  state.planHash = reviewPlan.rawData.planHash;
  await push({
    domain: 'review', command: 'review_execute', method: 'POST', path: '/api/review/health/execute',
    body: { planId: state.planId, planHash: state.planHash, confirmed: true, secondConfirmed: true },
  });

  // ── jobs（1）
  await push({ domain: 'jobs', command: 'job_list', method: 'GET', path: '/api/jobs', query: { limit: 50 }, note: '播种库内无后台任务，返回空数组。' });

  return results;
}

// ─────────────────────────────── 跳过清单 ───────────────────────────────

/** 已注册为 Rust 命令、但 Express 侧没有可录制端点的命令。 */
const SKIPPED_COMMANDS = [
  { command: 'vault_open', reason: 'Rust 内部命令，Express 无对应端点' },
  { command: 'vault_list', reason: 'Rust 内部命令，Express 无对应端点（列表语义由 note_index 覆盖）' },
  { command: 'vault_read', reason: 'Rust 内部命令，Express 无对应端点（文件读取由 file_read 覆盖）' },
  { command: 'vault_write', reason: 'Rust 内部命令，Express 无对应端点（写入分散在 note_update / canvas_write）' },
  { command: 'vault_search', reason: 'Rust 内部命令，Express 无对应端点（由 search_query 覆盖）' },
  { command: 'vault_scan', reason: 'Rust 内部命令，Express 无对应端点（无 HTTP 扫描入口）' },
  { command: 'vault_index_stats', reason: 'Rust 内部命令，Express 无对应端点（由 meta_overview 近似覆盖）' },
  { command: 'job_get', reason: '无法确定性播种：job 仅由 ai-reindex（P3 端点）创建' },
  { command: 'job_cancel', reason: '无法确定性播种：job 仅由 ai-reindex（P3 端点）创建' },
];

/** Express 有端点但未注册为 Rust 命令（契约状态 ⬜/⛔/🔁），不录。 */
const ENDPOINTS_WITHOUT_COMMAND = [
  { endpoint: 'PUT /api/vault/profile', command: 'vault_profile_set', reason: '契约 ⬜ 未实现（Rust 未注册）' },
  { endpoint: 'POST /api/vault/migrate', command: 'vault_migrate_sqlite', reason: '契约 ⬜ 未实现（Rust 未注册）' },
  { endpoint: 'GET /api/vault/assets', command: 'vault_assets_list', reason: '契约 ⬜ 未实现（Rust 未注册）' },
  { endpoint: 'GET /api/notes', command: 'note_list', reason: '契约 ⬜ 未实现（Rust 未注册）' },
  { endpoint: 'GET /api/notes/:id', command: 'note_get', reason: '契约 ⬜ 未实现（Rust 未注册）' },
  { endpoint: 'POST /api/notes/:id/duplicate', command: 'note_duplicate', reason: '契约 ⬜ 未实现（Rust 未注册）' },
  { endpoint: 'GET /api/notes/templates', command: 'note_templates_list', reason: '契约 ⬜ 未实现（Rust 未注册）' },
  { endpoint: 'POST /api/notes/from-template', command: 'note_create_from_template', reason: '契约 ⬜ 未实现（Rust 未注册）' },
  { endpoint: 'POST /api/notes/daily', command: 'note_create_daily', reason: '契约 ⬜ 未实现（Rust 未注册）' },
  { endpoint: 'DELETE /api/tags/:id', command: 'tag_delete', reason: '契约 ⬜ 未实现（Rust 未注册）' },
  { endpoint: 'GET /health', command: null, reason: '契约 ⛔ 随 Express 废弃' },
  { endpoint: 'GET /ready', command: null, reason: '契约 ⛔ 随 Express 废弃（由启动恢复序列替代）' },
  { endpoint: 'POST /api/workspace/sse-ticket', command: null, reason: '契约 ⛔ 随 Express 废弃（IPC 无需票据）' },
  { endpoint: 'GET /api/vault/events', command: null, reason: 'SSE 流式，改 Tauri event（P1-08 不录）' },
  { endpoint: 'POST /api/ai/chat/stream', command: null, reason: 'SSE 流式，P3' },
  { endpoint: 'POST /api/ai/write/stream', command: null, reason: 'SSE 流式，P3' },
  { endpoint: 'GET /api/update/check', command: 'update_check', reason: 'P4（改 tauri-plugin-updater）' },
  { endpoint: 'GET /api/mcp/info', command: 'mcp_info', reason: 'P4（MCP sidecar）' },
  { endpoint: 'GET /api/mcp/project', command: 'mcp_project_get', reason: 'P4（MCP sidecar）' },
  { endpoint: 'PUT /api/mcp/project', command: 'mcp_project_set', reason: 'P4（MCP sidecar）' },
];

// ─────────────────────────────── 快照与落盘 ───────────────────────────────

/** 复制 Vault 的可见用户文件；文本文件内的 ISO 时间戳归一，保证两次运行字节一致。 */
async function snapshotVault(vaultDir) {
  const files = new Map();
  await walk(vaultDir, '');
  return files;

  async function walk(absoluteDir, relativeDir) {
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // 跳过 .lattice/.fc 等内部目录
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const buffer = await fs.readFile(absolutePath);
      if (/\.(md|canvas)$/i.test(entry.name)) {
        files.set(relativePath, Buffer.from(buffer.toString('utf8').replace(ISO_GLOBAL_RE, '<timestamp>'), 'utf8'));
      } else {
        files.set(relativePath, buffer);
      }
    }
  }
}

function buildManifest(ctx) {
  const seed = ctx.seed;
  const folderPlaceholder = new Map(seed.folders.map((folder, index) => [folder.id, `<folderId:${index}>`]));
  return {
    note: '确定性播种清单。id 为播种时显式指定者（跨通道对齐锚点）；文件夹与标签 id 由服务端随机生成，此处以占位符表达（folderId:N 与 folder 条目的 id 一一对应），按 path/name 寻址。',
    notes: seed.notes
      .map((note) => ({
        id: note.id,
        filePath: note.filePath,
        title: note.title,
        folderId: note.folderId ? folderPlaceholder.get(note.folderId) ?? '<uuid>' : null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    folders: seed.folders
      .map((folder) => ({
        id: folderPlaceholder.get(folder.id),
        path: folderPathOf(seed.folders, folder),
        name: folder.name,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    tags: seed.tags
      .map((tag) => ({ id: '<uuid>', name: tag.name, noteCount: tag.noteCount }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    canvas: seed.canvas.map((item) => ({ path: item.path })),
    attachments: seed.attachments
      .map((item) => ({ path: item.path, name: item.name }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    experts: seed.experts.map((expert) => ({ id: expert.id, name: expert.name })),
    skills: seed.skills.map((skill) => ({ id: skill.id, name: skill.name })),
  };
}

function folderPathOf(folders, folder) {
  const byId = new Map(folders.map((item) => [item.id, item]));
  const parts = [];
  const visited = new Set();
  let current = folder;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return parts.join('/');
}

function groupByDomain(recorded) {
  const map = new Map();
  for (const { domain, caseObject } of recorded) {
    if (!map.has(domain)) map.set(domain, []);
    map.get(domain).push(caseObject.command);
  }
  return map;
}

async function writeFixtures(recorded, manifest, seedFiles) {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(FIXTURES_DIR, 'cases'), { recursive: true });

  // 1) seed/vault
  for (const [relativePath, buffer] of seedFiles) {
    const target = path.join(FIXTURES_DIR, 'seed', 'vault', relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
  }

  // 2) seed/manifest.json
  await fs.writeFile(
    path.join(FIXTURES_DIR, 'seed', 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  // 3) cases/<command>.json
  for (const { caseObject } of recorded) {
    await fs.writeFile(
      path.join(FIXTURES_DIR, 'cases', `${caseObject.command}.json`),
      `${JSON.stringify(caseObject, null, 2)}\n`,
      'utf8',
    );
  }

  // 4) index.json
  const byDomain = groupByDomain(recorded);
  const index = {
    note: 'P1-08 功能对齐验证 fixtures 索引。由 src-tauri/tests/tools/record-fixtures.mjs 生成，幂等：重复运行结果一致。',
    coverage: {
      recorded: recorded.length,
      skipped: SKIPPED_COMMANDS.length,
      registeredCommands: recorded.length + SKIPPED_COMMANDS.length,
      endpointsWithoutCommand: ENDPOINTS_WITHOUT_COMMAND.length,
    },
    domains: Object.fromEntries([...byDomain.entries()].map(([domain, commands]) => [domain, commands.slice().sort()])),
    cases: recorded
      .map(({ domain, caseObject }) => ({
        command: caseObject.command,
        domain,
        file: `cases/${caseObject.command}.json`,
        http: `${caseObject.http.method} ${caseObject.http.path}`,
      }))
      .sort((a, b) => a.command.localeCompare(b.command)),
    skippedCommands: SKIPPED_COMMANDS,
    endpointsWithoutCommand: ENDPOINTS_WITHOUT_COMMAND,
    normalization: {
      placeholders: {
        '<timestamp>': 'ISO-8601 时间戳（键名 createdAt/updatedAt/modifiedAt/at… 或正文/路径中内嵌的 ISO 时间）',
        '<uuid>': '非播种的随机/自动生成 UUID（含目录 id、tag id、plan id 等）',
        '<hash>': '64 位十六进制哈希（contentHash / planHash / canvas revision 等）',
        '<version>': '笔记历史版本标识 YYYYMMDDTHHMMSSmmmZ-<hash>',
        '<operationId>': 'files 操作 id <epochMs>-<8 hex>',
        '<vault>': '临时运行目录前缀（VAULT_DIR / DB 所在 mkdtemp 根）',
        '<repo>': '仓库根绝对路径前缀（内置专家/技能 filePath）',
      },
      durations: 'durationMs/tookMs/elapsedMs/duration 归零',
      anchors: '播种时显式指定的 id（note uuid、expert/skill id）原样保留',
      seedVault: 'seed/vault 下 .md/.canvas 文本内的 ISO 时间戳已归一为 <timestamp>，保证快照字节级可复现',
    },
  };
  await fs.writeFile(path.join(FIXTURES_DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

// ─────────────────────────────── 端口与就绪 ───────────────────────────────

async function reservePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    if (!BLOCKED_PORTS.has(port)) return port;
  }
  throw new Error('20 次尝试都没拿到未被 undici 屏蔽的端口');
}

async function waitUntilReady(baseUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/ready`);
      if (response.ok) return;
    } catch {
      // 后端仍在初始化数据库与 Vault 投影
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('录制用临时后端未在 10 秒内就绪');
}

// ─────────────────────────────── 主流程 ───────────────────────────────

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-fixtures-'));
  const vaultDir = path.join(tempRoot, 'vault');
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  RUNTIME.vaultDir = vaultDir;
  RUNTIME.tempRoot = tempRoot;

  const env = { ...process.env };
  // 清掉可能干扰的令牌/目录覆盖，固定为测试形态
  delete env.WORKSPACE_ACCESS_TOKEN;
  delete env.AI_ACCESS_TOKEN;
  Object.assign(env, {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    DB_FILE: path.join(tempRoot, 'lattice.db'),
    VAULT_DIR: vaultDir,
    AUTO_MIGRATE: 'true',
    WEB_DIST_DIR: path.join(tempRoot, 'missing-web-dist'),
  });

  const backend = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server', 'src', 'index.js')], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let exitCode = 0;
  try {
    await waitUntilReady(baseUrl);
    const ctx = { baseUrl, tempRoot, vaultDir, seed: {} };
    await seed(ctx);
    const seedFiles = await snapshotVault(vaultDir);
    const recorded = await recordAll(ctx);
    const manifest = buildManifest(ctx);
    await writeFixtures(recorded, manifest, seedFiles);
    printStats(recorded, seedFiles);
  } catch (error) {
    exitCode = 1;
    console.error('\n录制失败：');
    console.error(error?.stack ?? String(error));
  } finally {
    backend.kill();
    await once(backend, 'exit').catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

function printStats(recorded, seedFiles) {
  const byDomain = groupByDomain(recorded);
  const lines = [];
  lines.push('');
  lines.push(`录得 ${recorded.length} 个 case · 跳过 ${SKIPPED_COMMANDS.length} 个（已注册命令共 ${recorded.length + SKIPPED_COMMANDS.length}）`);
  lines.push(`另有 ${ENDPOINTS_WITHOUT_COMMAND.length} 条 Express 端点未注册为 Rust 命令（不录）`);
  lines.push('');
  lines.push('按域分组：');
  for (const [domain, commands] of [...byDomain.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  [${domain}] ${commands.slice().sort().join(', ')}`);
  }
  lines.push('');
  lines.push('跳过明细：');
  for (const { command, reason } of SKIPPED_COMMANDS) lines.push(`  - ${command}: ${reason}`);
  lines.push('');
  lines.push('Express 有端点但 Rust 未注册：');
  for (const { endpoint, command, reason } of ENDPOINTS_WITHOUT_COMMAND) {
    lines.push(`  - ${endpoint}${command ? ` → ${command}` : ''}: ${reason}`);
  }
  lines.push('');
  lines.push(`seed/vault 可见文件：${seedFiles.size} 个`);
  lines.push(`产物目录：${FIXTURES_DIR}`);
  lines.push('');
  console.log(lines.join('\n'));
}

main();
