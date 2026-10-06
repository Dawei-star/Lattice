import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-session-http-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';
process.env.AI_ALLOW_PRIVATE_ENDPOINTS = 'true';

const { openDatabase, closeDatabase } = await import('../src/db/index.js');
const { runMigrations } = await import('../src/db/migrate.js');
const sessions = await import('../src/modules/ai/ai.sessions.js');
const { createApp } = await import('../src/app.js');

openDatabase();
runMigrations();

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
  });
}

test('session messages remain readable when the client sends a conditional GET', async () => {
  const session = sessions.createSession({ id: 'sess-http-cache', expertId: 'general' });
  sessions.appendMessage(session.id, { role: 'user', content: 'first question' });
  sessions.appendMessage(session.id, { role: 'assistant', content: 'first answer' });

  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const url = `http://127.0.0.1:${server.address().port}/api/ai/sessions/${session.id}/messages`;
    const first = await request(url);
    assert.equal(first.status, 200);
    assert.ok(first.body.includes('first question'));

    const conditional = await request(url, { 'if-none-match': '*' });
    assert.equal(conditional.status, 200);
    assert.ok(conditional.body.includes('first answer'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
  }
});
