/** Minimal MCP stdio smoke test: read-only by default, writes only when opted in. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-mcp-e2e-'));
const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

function launch(allowWrites) {
  const env = { ...process.env, NODE_ENV: 'test', DB_FILE: path.join(root, `${allowWrites ? 'write' : 'read'}-db.sqlite`), VAULT_DIR: path.join(root, `${allowWrites ? 'write' : 'read'}-vault`) };
  if (allowWrites) env.LATTICE_MCP_ALLOW_WRITES = 'true';
  else delete env.LATTICE_MCP_ALLOW_WRITES;
  const child = spawn(process.execPath, [serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const responses = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { const message = JSON.parse(line); if (message.id !== undefined) responses.set(message.id, message); } catch { /* protocol output is asserted below */ }
    }
  });
  const send = (id, method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const waitFor = async (id) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (responses.has(id)) return responses.get(id);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`MCP response timeout: ${id}`);
  };
  return { child, send, waitFor };
}

async function stop(child) {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

try {
  const readonly = launch(false);
  readonly.send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  await readonly.waitFor(1);
  readonly.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  readonly.send(2, 'tools/list');
  const readTools = (await readonly.waitFor(2)).result?.tools?.map((tool) => tool.name) ?? [];
  if (readTools.includes('create_note')) throw new Error('MCP writes must be disabled by default');
  await stop(readonly.child);

  const writable = launch(true);
  writable.send(3, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  await writable.waitFor(3);
  writable.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  writable.send(4, 'tools/list');
  const writeTools = (await writable.waitFor(4)).result?.tools?.map((tool) => tool.name) ?? [];
  for (const name of ['list_notes', 'search_notes', 'read_note', 'get_vault_statistics', 'list_note_history', 'create_note', 'update_note', 'restore_note_version']) {
    if (!writeTools.includes(name)) throw new Error(`${name} is not registered`);
  }
  writable.send(5, 'tools/call', { name: 'create_note', arguments: { title: 'MCP smoke note', content: 'smoke content' } });
  const created = await writable.waitFor(5);
  if (!JSON.parse(created.result?.content?.[0]?.text ?? '{}').id) throw new Error('create_note failed');
  await stop(writable.child);
  console.log('MCP E2E PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
