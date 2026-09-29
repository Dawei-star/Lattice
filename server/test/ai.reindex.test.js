import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-reindex-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';

const { runMigrations } = await import('../src/db/migrate.js');
runMigrations();
const { getDb } = await import('../src/db/index.js');
const { getJob, recoverJobs } = await import('../src/lib/jobs.js');
const { reindexAll } = await import('../src/modules/ai/ai.indexer.js');

const timestamp = new Date().toISOString();
getDb().prepare(
  `INSERT INTO notes (id, title, content, is_pinned, word_count, content_hash, created_at, updated_at)
   VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
).run('reindex-note', 'Reindex note', 'body', 4, 'hash-reindex-note', timestamp, timestamp);
recoverJobs();

test('semantic reindex is persisted as a background job', async () => {
  const queued = reindexAll();
  assert.equal(queued.type, 'ai-reindex');
  assert.equal(queued.total, 1);

  const deadline = Date.now() + 2_000;
  let job = getJob(queued.id);
  while (job.status !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    job = getJob(queued.id);
  }

  assert.equal(job.status, 'completed');
  assert.deepEqual(job.result, {
    total: 1,
    processed: 1,
    indexed: 0,
    skipped: 1,
    failed: 0,
    cancelled: false,
  });
  assert.equal(getDb().prepare('SELECT status FROM ai_index_state WHERE note_id = ?').get('reindex-note').status, 'pending');
});
