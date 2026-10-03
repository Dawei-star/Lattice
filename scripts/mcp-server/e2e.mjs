/** MCP stdio end-to-end check: initialize -> tools/list -> create/search/read/update/error. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-mcp-e2e-'));
// fileURLToPath 会正确解码空格/中文/# 等百分号编码；URL.pathname 手工去盘符的
// 写法在中文或空格路径下直接 ENOENT
const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** kill 后等进程真正退出（带 2s 兜底），句柄不释放会导致后续 rmSync 抛 EBUSY */
function stopChild(child) {
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.once('exit', done);
    child.once('error', done);
    child.kill();
    setTimeout(done, 2000).unref();
  });
}

function launch({ allowWrites }) {
  const env = {
    ...process.env,
    DB_FILE: path.join(runtimeRoot, allowWrites ? 'enabled.db' : 'readonly.db'),
    VAULT_DIR: path.join(runtimeRoot, allowWrites ? 'enabled-vault' : 'readonly-vault'),
    NODE_ENV: 'test',
  };
  delete env.LATTICE_MCP_ALLOW_WRITES;
  if (allowWrites) env.LATTICE_MCP_ALLOW_WRITES = 'true';

  const child = spawn(process.execPath, [serverPath], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const responses = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        responses.push(JSON.parse(line));
      } catch {
        // Ignore non-JSON stdout noise so the assertion below reports the real failure.
      }
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[mcp] ${chunk}`));

  const send = (object) => child.stdin.write(`${JSON.stringify(object)}\n`);
  const find = (id) => responses.find((response) => response.id === id);
  const waitFor = async (id, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = find(id);
      if (response) return response;
      await wait(25);
    }
    throw new Error(`MCP response timeout: ${id}`);
  };
  return { child, send, waitFor };
}

let activeChild = null;
try {
  const readonly = launch({ allowWrites: false });
  try {
    readonly.send({ jsonrpc: '2.0', id: 101, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'readonly-client', version: '0' } } });
    await readonly.waitFor(101);
    readonly.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    readonly.send({ jsonrpc: '2.0', id: 102, method: 'tools/list' });
    const readonlyToolList = await readonly.waitFor(102);
    const readonlyTools = readonlyToolList.result?.tools?.map((tool) => tool.name) ?? [];
    for (const name of ['create_note', 'update_note', 'restore_note_version']) {
      if (readonlyTools.includes(name)) throw new Error(`${name} must be disabled by default`);
    }
    console.log('default MCP mode: read-only');
  } finally {
    await stopChild(readonly.child);
  }

  const active = launch({ allowWrites: true });
  const { child, send, waitFor } = active;
  activeChild = child;
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '0' } } });
  await waitFor(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const toolList = await waitFor(2);

  const tools = toolList.result?.tools?.map((tool) => tool.name) ?? [];
  console.log('tools:', tools.join(', '));
  for (const name of ['list_notes', 'search_notes', 'read_note', 'create_note', 'update_note', 'get_note_links', 'list_tags', 'get_vault_statistics', 'list_note_history', 'restore_note_version']) {
    if (!tools.includes(name)) throw new Error(`${name} tool is not registered`);
  }

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_note', arguments: { title: 'MCP test note', content: '# From MCP\n\nCreated by an external Agent.' } } });
  const created = await waitFor(3);
  const createdPayload = JSON.parse(created.result?.content?.[0]?.text ?? '{}');
  if (!createdPayload.id) throw new Error('create_note did not return a note ID');

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'external Agent' } } });
  const searched = await waitFor(4);

  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_note', arguments: { query: 'MCP test note' } } });
  const read = await waitFor(5);

  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'update_note', arguments: { noteId: createdPayload.id, content: '# From MCP\n\nUpdated by an external Agent.' } } });
  const updated = await waitFor(6);

  send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read_note', arguments: { query: 'missing MCP note' } } });
  const missing = await waitFor(7);

  send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'update_note', arguments: { noteId: createdPayload.id, content: 'Appended by MCP e2e.', mode: 'append' } } });
  const appended = await waitFor(8);

  send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_note', arguments: { title: 'Linked note', content: 'See [[MCP test note]]. #e2e' } } });
  const linked = await waitFor(9);
  const linkedPayload = JSON.parse(linked.result?.content?.[0]?.text ?? '{}');

  send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_note_links', arguments: { query: createdPayload.id } } });
  const links = await waitFor(10);

  send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'list_tags', arguments: {} } });
  const tags = await waitFor(11);

  send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'get_vault_statistics', arguments: {} } });
  const stats = await waitFor(12);

  send({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'list_note_history', arguments: { noteId: createdPayload.id } } });
  const history = await waitFor(13);
  const historyPayload = JSON.parse(history.result?.content?.[0]?.text ?? '{}');
  if (!historyPayload.versions?.length) throw new Error('list_note_history returned no versions');

  send({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'restore_note_version', arguments: { noteId: createdPayload.id, version: historyPayload.versions[0].version } } });
  const restored = await waitFor(14);
  const restoredPayload = JSON.parse(restored.result?.content?.[0]?.text ?? '{}');
  const auditEntries = fs.readFileSync(path.join(runtimeRoot, 'ai-audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const mcpWrites = auditEntries.filter((entry) => entry.source === 'mcp');

  const searchItems = JSON.parse(searched.result?.content?.[0]?.text ?? '{}').items ?? [];
  const readPayload = JSON.parse(read.result?.content?.[0]?.text ?? '{}');
  const updatedPayload = JSON.parse(updated.result?.content?.[0]?.text ?? '{}');
  const appendedPayload = JSON.parse(appended.result?.content?.[0]?.text ?? '{}');
  const linksPayload = JSON.parse(links.result?.content?.[0]?.text ?? '{}');
  const tagsPayload = JSON.parse(tags.result?.content?.[0]?.text ?? '{}');
  const statsPayload = JSON.parse(stats.result?.content?.[0]?.text ?? '{}');
  console.log('create:', created.result?.content?.[0]?.text?.slice(0, 120) ?? JSON.stringify(created.error));
  console.log('search hits:', searchItems.length, searchItems[0]?.title ?? '');
  console.log('read:', readPayload.title, '|', readPayload.content?.includes('external Agent') ? 'content-ok' : 'content-missing');
  console.log('links:', JSON.stringify(linksPayload.outgoing?.length), 'outgoing /', JSON.stringify(linksPayload.backlinks?.length), 'backlinks');
  console.log('tags:', tagsPayload.map?.((tag) => tag.name).join(', ') ?? JSON.stringify(tagsPayload));
  console.log('stats:', statsPayload.noteCount, 'notes,', statsPayload.danglingCount, 'dangling');
  console.log('history:', historyPayload.versions?.length, 'versions');
  console.log('restore:', restoredPayload.restored ? 'ok' : JSON.stringify(restored.error));
  console.log('audit:', mcpWrites.length, 'MCP writes');

  if (!searchItems.length) throw new Error('search did not find the created note');
  if (!readPayload.content?.includes('external Agent')) throw new Error('read content is incomplete');
  if (!updatedPayload.updated) throw new Error('update_note did not confirm the update');
  if (!missing.result?.isError) throw new Error('missing note did not return isError');
  if (!appendedPayload.updated || appendedPayload.mode !== 'append') throw new Error('append mode did not confirm');
  if (!linksPayload.backlinks?.some((link) => link.noteId === linkedPayload.id)) throw new Error('get_note_links missed the backlink');
  if (!tagsPayload.some?.((tag) => tag.name === 'e2e')) throw new Error('list_tags missed the #e2e tag');
  if (statsPayload.noteCount !== 2) throw new Error('get_vault_statistics note count mismatch: ' + statsPayload.noteCount);
  if (!restoredPayload.restored) throw new Error('restore_note_version did not confirm');
  for (const type of ['create', 'update', 'restore']) {
    if (!mcpWrites.some((entry) => entry.actor === 'mcp' && entry.action?.type === type && entry.status === 'completed')) {
      throw new Error(`MCP ${type} write was not audited`);
    }
  }
  console.log('MCP E2E PASS');
} finally {
  await stopChild(activeChild);
  try {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  } catch (error) {
    // 清理失败不能掩盖真正的测试失败原因
    process.stderr.write(`[e2e] runtime cleanup failed: ${error.message}\n`);
  }
}
