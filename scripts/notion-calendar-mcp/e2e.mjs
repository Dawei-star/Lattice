/** Minimal MCP stdio smoke test backed by a local fake Notion API. */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(root, 'server.mjs');
const fakePage = {
  object: 'page',
  id: 'page-1',
  url: 'https://www.notion.so/page-1',
  properties: {
    Name: { id: 'title', type: 'title', title: [{ plain_text: 'Demo event' }] },
    When: { id: 'date', type: 'date', date: { start: '2026-10-12', end: null, time_zone: null } },
  },
};

const fakeApi = http.createServer(async (request, response) => {
  const bodyChunks = [];
  for await (const chunk of request) bodyChunks.push(chunk);
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const body = bodyChunks.length ? JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) : null;
  response.setHeader('Content-Type', 'application/json');
  if (pathname === '/v1/databases/db-1') return response.end(JSON.stringify({ object: 'database', id: 'db-1', data_sources: [{ id: 'source-1' }] }));
  if (pathname === '/v1/data_sources/source-1') return response.end(JSON.stringify({ object: 'data_source', id: 'source-1', properties: { Name: { name: 'Name', type: 'title' }, When: { name: 'When', type: 'date' } } }));
  if (pathname === '/v1/data_sources/source-1/query') return response.end(JSON.stringify({ results: [fakePage], has_more: false, next_cursor: null, received: body }));
  response.statusCode = 404;
  return response.end(JSON.stringify({ code: 'not_found', message: 'fake route not found' }));
});

function launch(baseUrl) {
  const env = {
    ...process.env,
    NOTION_API_KEY: 'secret-e2e',
    NOTION_DATABASE_ID: 'db-1',
    NOTION_API_BASE_URL: baseUrl,
  };
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
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) responses.set(message.id, message);
      } catch {
        // The MCP transport should be the only stdout protocol writer.
      }
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
  await new Promise((resolve) => fakeApi.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${fakeApi.address().port}/v1`;
  const client = launch(baseUrl);
  client.send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  await client.waitFor(1);
  client.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  client.send(2, 'tools/list');
  const names = (await client.waitFor(2)).result?.tools?.map((tool) => tool.name) ?? [];
  for (const name of ['list_calendar_events', 'get_calendar_event', 'create_calendar_event', 'update_calendar_event', 'archive_calendar_event']) {
    if (!names.includes(name)) throw new Error(`${name} is not registered`);
  }
  client.send(3, 'tools/call', { name: 'list_calendar_events', arguments: { limit: 10 } });
  const result = await client.waitFor(3);
  const events = JSON.parse(result.result?.content?.[0]?.text ?? '[]');
  if (events[0]?.id !== 'page-1') throw new Error('list_calendar_events returned an unexpected event');
  await stop(client.child);
  console.log('NOTION CALENDAR MCP E2E PASS');
} finally {
  await new Promise((resolve) => fakeApi.close(resolve));
}
