#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'scripts', 'fc.mjs');
const runId = `lattice-fc-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), `${runId}-`));

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function runCli(args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      status: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      json: parseJson(result.stdout),
      errorJson: parseJson(result.stderr),
    };
  } catch (error) {
    const stdout = error.stdout ?? '';
    const stderr = error.stderr ?? '';
    const status = Number.isInteger(error.status)
      ? error.status
      : Number.isInteger(error.code) ? error.code : 1;
    return {
      status,
      stdout,
      stderr,
      json: parseJson(stdout),
      errorJson: parseJson(stderr),
    };
  }
}

function withRoot(...args) {
  return ['--root', root, ...args];
}

function expectSuccess(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${result.stderr || result.stdout}`);
  assert.ok(result.json, `${label} did not return JSON on stdout`);
  return result.json;
}

function expectFailure(result, label) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.ok(result.errorJson, `${label} did not return JSON on stderr: ${result.stderr}`);
  assert.equal(typeof result.errorJson.error?.message, 'string', `${label} has no error message`);
  return result.errorJson.error;
}

function writeFixture(relativePath, content) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function readFixture(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');
}

async function main() {
  let passed = 0;
  const check = async (label, callback) => {
    await callback();
    passed += 1;
    console.log(`ok - ${label}`);
  };

  try {
    writeFixture('notes/today.md', 'title\nneedle 2026\n');
    writeFixture('docs/guide.md', 'guide\nneedle-42\n');
    writeFixture('docs/readme.txt', 'needle in text\n');
    writeFixture('inbox/source.txt', 'archive me\n');

    await check('help lists the CLI command groups', async () => {
      const result = await runCli(['--help']);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /stat <path>/);
      assert.match(result.stdout, /batch <plan\.json>/);
    });

    await check('stat reports existing and missing files', async () => {
      const file = expectSuccess(await runCli(withRoot('stat', 'notes/today.md')), 'stat existing file');
      assert.equal(file.exists, true);
      assert.equal(file.type, 'file');
      assert.match(file.sha256, /^[a-f0-9]{64}$/);

      const missing = expectSuccess(await runCli(withRoot('stat', 'notes/missing.md')), 'stat missing file');
      assert.deepEqual(missing, { path: 'notes/missing.md', exists: false, type: 'missing' });
    });

    await check('create and read round-trip file content', async () => {
      expectSuccess(await runCli(withRoot('create', 'notes/new.md', '--content', 'created\n', '--yes')), 'create');
      const result = expectSuccess(await runCli(withRoot('read', 'notes/new.md')), 'read');
      assert.equal(result.content, 'created\n');
      assert.equal(result.eof, true);
    });

    await check('write dry-run returns a diff without changing the file', async () => {
      const before = readFixture('notes/new.md');
      const result = expectSuccess(await runCli(withRoot('write', 'notes/new.md', '--content', 'rewritten\n', '--dry-run')), 'write dry-run');
      assert.equal(result.dryRun, true);
      assert.match(result.diff, /-created/);
      assert.match(result.diff, /\+rewritten/);
      assert.equal(readFixture('notes/new.md'), before);
    });

    await check('edit and append apply deterministic text changes', async () => {
      expectSuccess(await runCli(withRoot('edit', 'notes/new.md', '--replace', 'created', '--with', 'updated', '--yes')), 'edit');
      expectSuccess(await runCli(withRoot('append', 'notes/new.md', '--content', 'appended\n', '--yes')), 'append');
      assert.equal(readFixture('notes/new.md'), 'updated\nappended\n');
    });

    await check('find filters extensions and returns portable paths', async () => {
      const result = expectSuccess(await runCli(withRoot('find', '**/*.md', '--type', 'md')), 'find');
      const paths = result.items.map((item) => item.path);
      assert.deepEqual(paths, ['docs/guide.md', 'notes/new.md', 'notes/today.md']);
      assert.ok(paths.every((item) => !item.includes('\\')));
    });

    await check('grep supports text and regular expression searches', async () => {
      const text = expectSuccess(await runCli(withRoot('grep', 'needle', 'docs', '--type', 'md')), 'grep text');
      assert.deepEqual(text.items.map((item) => ({ path: item.path, line: item.line })), [{ path: 'docs/guide.md', line: 2 }]);

      const regex = expectSuccess(await runCli(withRoot('grep', 'needle-\\d+', 'docs', '--regex')), 'grep regex');
      assert.equal(regex.total, 1);
      assert.equal(regex.items[0].text, 'needle-42');
    });

    const batchPlan = {
      actions: [
        { type: 'mkdir', path: 'archive' },
        { type: 'move', path: 'inbox/source.txt', targetPath: 'archive/source.txt' },
      ],
    };
    writeFixture('plans/archive.json', `${JSON.stringify(batchPlan, null, 2)}\n`);

    let batchResult;
    await check('batch dry-run previews all actions and produces a plan hash', async () => {
      const result = expectSuccess(await runCli(withRoot('batch', 'plans/archive.json', '--dry-run')), 'batch dry-run');
      assert.equal(result.dryRun, true);
      assert.equal(result.total, 2);
      assert.match(result.planHash, /^[a-f0-9]{64}$/);
      assert.equal(fs.existsSync(path.join(root, 'archive')), false);
      assert.equal(fs.existsSync(path.join(root, 'inbox', 'source.txt')), true);
      batchResult = result;
    });

    await check('batch executes only with the matching plan hash', async () => {
      const result = expectSuccess(await runCli(withRoot('batch', 'plans/archive.json', '--yes', '--plan-hash', batchResult.planHash)), 'batch execute');
      assert.match(result.batchId, /^[0-9]+-[a-f0-9-]+$/);
      assert.equal(result.operationIds.length, 2);
      assert.equal(readFixture('archive/source.txt'), 'archive me\n');
      assert.equal(fs.existsSync(path.join(root, 'inbox', 'source.txt')), false);
      batchResult = result;
    });

    await check('undo restores batch operations in reverse order', async () => {
      expectSuccess(await runCli(withRoot('undo', batchResult.operationIds[1])), 'undo move');
      expectSuccess(await runCli(withRoot('undo', batchResult.operationIds[0])), 'undo mkdir');
      assert.equal(readFixture('inbox/source.txt'), 'archive me\n');
      assert.equal(fs.existsSync(path.join(root, 'archive')), false);
    });

    await check('stale batch plan hashes fail without overwriting external changes', async () => {
      const stalePlan = { actions: [{ type: 'write', path: 'stale.txt', content: 'planned\n' }] };
      writeFixture('plans/stale.json', `${JSON.stringify(stalePlan)}\n`);
      const preview = expectSuccess(await runCli(withRoot('batch', 'plans/stale.json', '--dry-run')), 'stale batch dry-run');
      writeFixture('stale.txt', 'changed externally\n');

      const error = expectFailure(await runCli(withRoot('batch', 'plans/stale.json', '--yes', '--plan-hash', preview.planHash)), 'stale batch');
      assert.match(error.message, /Batch plan hash mismatch/);
      assert.equal(readFixture('stale.txt'), 'changed externally\n');
    });

    await check('log includes batch and operation audit identifiers', async () => {
      const entries = expectSuccess(await runCli(withRoot('log', '--limit', '100')), 'log');
      assert.ok(entries.some((entry) => entry.batchId === batchResult.batchId));
      assert.ok(entries.some((entry) => entry.operationId === batchResult.operationIds[1]));
    });

    await check('non-interactive writes require explicit confirmation', async () => {
      const error = expectFailure(await runCli(withRoot('write', 'guarded.txt', '--content', 'must not write')), 'write without yes');
      assert.match(error.message, /requires --yes/);
      assert.equal(fs.existsSync(path.join(root, 'guarded.txt')), false);
    });

    await check('path traversal and internal state paths are rejected as JSON errors', async () => {
      const traversal = expectFailure(await runCli(withRoot('read', '../outside.txt')), 'path traversal');
      assert.match(traversal.message, /traversal|escapes root/i);

      const internal = expectFailure(await runCli(withRoot('stat', '.fc/audit.jsonl')), 'internal state path');
      assert.match(internal.message, /reserved/i);
    });

    console.log(`\nFC CLI smoke test passed: ${passed} checks`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(`FC CLI smoke test failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
