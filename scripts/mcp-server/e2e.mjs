/** MCP stdio end-to-end check: initialize -> tools/list -> create/search/read/update/error. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-mcp-e2e-'));
const serverPath = new URL('./server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    DB_FILE: path.join(runtimeRoot, 'lattice.db'),
    VAULT_DIR: path.join(runtimeRoot, 'vault'),
    NODE_ENV: 'test',
  },
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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const find = (id) => responses.find((response) => response.id === id);
const waitFor = async (id, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = find(id);
    if (response) return response;
    await wait(25);
  }
  throw new Error(`MCP response timeout: ${id}`);
};

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '0' } } });
  await waitFor(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const toolList = await waitFor(2);

  const tools = toolList.result?.tools?.map((tool) => tool.name) ?? [];
  console.log('tools:', tools.join(', '));
  for (const name of ['list_notes', 'search_notes', 'read_note', 'create_note', 'update_note']) {
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

  const searchItems = JSON.parse(searched.result?.content?.[0]?.text ?? '{}').items ?? [];
  const readPayload = JSON.parse(read.result?.content?.[0]?.text ?? '{}');
  const updatedPayload = JSON.parse(updated.result?.content?.[0]?.text ?? '{}');
  console.log('create:', created.result?.content?.[0]?.text?.slice(0, 120) ?? JSON.stringify(created.error));
  console.log('search hits:', searchItems.length, searchItems[0]?.title ?? '');
  console.log('read:', readPayload.title, '|', readPayload.content?.includes('external Agent') ? 'content-ok' : 'content-missing');

  if (!searchItems.length) throw new Error('search did not find the created note');
  if (!readPayload.content?.includes('external Agent')) throw new Error('read content is incomplete');
  if (!updatedPayload.updated) throw new Error('update_note did not confirm the update');
  if (!missing.result?.isError) throw new Error('missing note did not return isError');
  console.log('MCP E2E PASS');
} finally {
  child.kill();
  await wait(200);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}
