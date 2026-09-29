import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-jobs-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';

const { runMigrations } = await import('../src/db/migrate.js');
runMigrations();
const { getDb } = await import('../src/db/index.js');
const { cancelJob, enqueueJob, getJob, listJobs, recoverJobs, registerJobHandler } = await import('../src/lib/jobs.js');

recoverJobs();

const waitFor = async (id, predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJob(id);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`job ${id} did not reach the expected state`);
};

test('jobs persist progress and complete with a result', async () => {
  const type = 'test-complete';
  registerJobHandler(type, async (_payload, context) => {
    context.update({ progress: 1, total: 2, message: 'halfway' });
    await new Promise((resolve) => setImmediate(resolve));
    context.update({ progress: 2 });
    return { ok: true };
  });

  const created = enqueueJob({ type, total: 2, payload: { input: 'value' } });
  assert.equal(created.status, 'queued');
  assert.deepEqual(created.payload, { input: 'value' });

  const completed = await waitFor(created.id, (job) => job?.status === 'completed');
  assert.equal(completed.progress, 2);
  assert.equal(completed.total, 2);
  assert.equal(completed.message, 'halfway');
  assert.deepEqual(completed.result, { ok: true });
  assert.equal(getJob(created.id).id, created.id);
  assert.equal(listJobs({ type, limit: 1 })[0].id, created.id);
});

test('jobs record failures and enforce active idempotency', async () => {
  const type = 'test-failure';
  registerJobHandler(type, async () => {
    throw new Error('expected failure');
  });

  const first = enqueueJob({ type, idempotencyKey: 'same-request' });
  const duplicate = enqueueJob({ type, idempotencyKey: 'same-request' });
  assert.equal(duplicate.id, first.id);
  const failed = await waitFor(first.id, (job) => job?.status === 'failed');
  assert.match(failed.error, /expected failure/);
  assert.equal(failed.attempts, 1);
});

test('running jobs can be cancelled and finish as cancelled', async () => {
  const type = 'test-cancel';
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  registerJobHandler(type, async (_payload, context) => {
    started();
    while (!context.isCancelled()) await new Promise((resolve) => setTimeout(resolve, 5));
    return { stopped: true };
  });

  const created = enqueueJob({ type });
  await startedPromise;
  const cancelled = cancelJob(created.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(getJob(created.id).status, 'cancelled');
  const finished = await waitFor(created.id, (job) => job?.status === 'cancelled');
  assert.equal(finished.error, '用户取消');
});

test('startup recovery requeues interrupted jobs', async () => {
  const type = 'test-recovery';
  registerJobHandler(type, async () => ({ recovered: true }));
  const id = 'recovery-job';
  const timestamp = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO jobs (id, type, status, progress, total, payload, attempts, created_at, started_at, updated_at)
     VALUES (?, ?, 'running', 1, 2, '{}', 1, ?, ?, ?)`,
  ).run(id, type, timestamp, timestamp, timestamp);

  recoverJobs();
  const recovered = await waitFor(id, (job) => job?.status === 'completed');
  assert.equal(recovered.attempts, 2);
  assert.deepEqual(recovered.result, { recovered: true });
});
