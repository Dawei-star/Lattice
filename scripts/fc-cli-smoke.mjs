#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
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

/**
 * 异步跑 CLI 并把 `input` 写进 stdin（`shell` 用例需要喂多行脚本）。
 *
 * ⚠️ **不能用 `spawnSync`**：本机（WorkBuddy 宿主）对**任何**二进制调同步子进程 API 都会
 * 返回 `error.code === 'EBUSY'` / `status === null`，于是 `assert.equal(result.status, 0)`
 * 报 `null !== 0`，看起来像产品回归、实际是环境不支持（`fc unit` 全绿而只有这两条红）。
 * promisify 后的 `execFile` 又没有 `input` 选项，所以这里用 `spawn` 手写收流。
 */
function runCliWithInput(args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      env: process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => resolve({ status: Number.isInteger(code) ? code : 1, stdout, stderr }));
    child.stdin.end(input);
  });
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(predicate, label, timeout = 10000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeout) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function startServe(extraArgs = []) {
  const child = spawn(process.execPath, [cliPath, '--root', root, ...extraArgs, 'serve'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = [];
  let stderr = '';
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) lines.push(parseJson(line));
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const send = (request) => child.stdin.write(`${JSON.stringify(request)}\n`);
  const sendRaw = (text) => child.stdin.write(`${text.trim()}\n`);
  return { child, lines, get stderr() { return stderr; }, exited, send, sendRaw };
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

    await check('-V prints the application version', async () => {
      const result = await runCli(['-V']);
      assert.equal(result.status, 0);
      assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
    });

    await check('help <command> prints per-command details', async () => {
      const result = await runCli(['help', 'edit']);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /--replace/);
      assert.match(result.stdout, /--all/);

      const unknown = expectFailure(await runCli(['help', 'nope']), 'help unknown');
      assert.match(unknown.message, /No help available/);
    });

    await check('doctor reports a healthy root with pending undo operations', async () => {
      expectSuccess(await runCli(withRoot('create', 'notes/doctor.md', '--content', 'doctor\n', '--yes')), 'create for doctor');
      const result = expectSuccess(await runCli(withRoot('doctor')), 'doctor healthy');
      assert.equal(result.ok, true);
      assert.equal(result.checks.every((check) => typeof check.name === 'string' && typeof check.ok === 'boolean'), true);
      const trash = result.checks.find((check) => check.name === 'trash');
      assert.match(trash.detail, /pending undo/);
      assert.ok(Number(trash.detail.match(/(\d+) pending undo/)[1]) >= 1);
    });

    await check('doctor fails on an unreadable undo manifest', async () => {
      expectSuccess(await runCli(withRoot('create', 'notes/broken.md', '--content', 'broken\n', '--yes')), 'create for broken manifest');
      const trashDir = path.join(root, '.fc', 'trash');
      const newest = fs.readdirSync(trashDir).sort().at(-1);
      fs.writeFileSync(path.join(trashDir, newest, 'manifest.json'), 'not-json', 'utf8');

      const result = await runCli(withRoot('doctor'));
      assert.notEqual(result.status, 0, 'doctor should exit non-zero on a broken manifest');
      assert.equal(result.json.ok, false);
      const trash = result.json.checks.find((check) => check.name === 'trash');
      assert.equal(trash.ok, false);
      assert.match(trash.detail, /manifest unreadable/);
    });

    await check('readonly mode blocks mutations and undo but keeps reads and previews', async () => {
      const deniedCreate = expectFailure(await runCli(withRoot('--mode', 'readonly', 'create', 'blocked.md', '--content', 'no', '--yes')), 'readonly create');
      assert.equal(deniedCreate.code, 'FC_READ_ONLY');
      assert.equal(fs.existsSync(path.join(root, 'blocked.md')), false);

      const deniedUndo = expectFailure(await runCli(withRoot('--mode', 'readonly', 'undo')), 'readonly undo');
      assert.equal(deniedUndo.code, 'FC_READ_ONLY');

      const deniedBatch = expectFailure(await runCli(withRoot('--mode', 'readonly', 'batch', 'plans/archive.json')), 'readonly batch');
      assert.equal(deniedBatch.code, 'FC_READ_ONLY');

      const preview = expectSuccess(await runCli(withRoot('--mode', 'readonly', 'write', 'notes/doctor.md', '--content', 'preview only', '--dry-run')), 'readonly dry-run');
      assert.equal(preview.dryRun, true);

      const read = expectSuccess(await runCli(withRoot('--mode', 'readonly', 'grep', 'doctor')), 'readonly grep');
      assert.ok(read.total >= 1);
    });

    await check('shell executes piped commands until /exit', async () => {
      const script = [
        '# a comment line is ignored',
        'create notes/shell.md --content "from shell" --yes',
        'read notes/shell.md',
        'totally-unknown',
        'grep "from shell" notes',
        '/exit',
        'create notes/after-exit.md --content "never" --yes',
      ].join('\n');
      const result = await runCliWithInput(['--root', root, 'shell'], script);
      assert.equal(result.status, 0, result.stderr);

      const events = result.stdout.trim().split(/\r?\n/).map(parseJson).filter(Boolean);
      assert.equal(events.at(-1).event, 'exit');
      assert.equal(events.at(-1).commands, 3);
      assert.equal(events.at(-1).errors, 1);

      const read = events.find((event) => event.content !== undefined);
      assert.equal(read.content, 'from shell');
      assert.ok(events.some((event) => event.query === 'from shell'), 'grep ran inside the session');
      assert.equal(fs.existsSync(path.join(root, 'notes', 'after-exit.md')), false, 'lines after /exit must not run');

      const errorLine = result.stderr.trim().split(/\r?\n/).map(parseJson).filter(Boolean).at(-1);
      assert.match(errorLine.error.message, /Unknown command/);
    });

    await check('shell honours readonly mode', async () => {
      const result = await runCliWithInput(
        ['--root', root, '--mode', 'readonly', 'shell'],
        'create notes/blocked-in-shell.md --content no --yes\n/exit\n',
      );
      assert.equal(result.status, 0, result.stderr);
      const errorLine = result.stderr.trim().split(/\r?\n/).map(parseJson).filter(Boolean).at(-1);
      assert.equal(errorLine.error.code, 'FC_READ_ONLY');
      assert.equal(fs.existsSync(path.join(root, 'notes', 'blocked-in-shell.md')), false);
    });

    await check('serve answers JSON-lines requests and survives unknown commands', async () => {
      const session = startServe();
      try {
        await waitFor(() => session.lines.length >= 1, 'ready');
        assert.equal(session.lines[0].event, 'ready');
        assert.equal(session.lines[0].mode, 'default');

        session.send({ id: 1, command: 'ping' });
        await waitFor(() => session.lines.length >= 2, 'ping');
        assert.equal(session.lines[1].result.pong, true);

        session.send({ id: 2, command: 'create', args: ['notes/served.md'], options: { content: 'served\n', yes: true } });
        await waitFor(() => session.lines.length >= 3, 'create');
        assert.equal(session.lines[2].result.path, 'notes/served.md');

        session.send({ id: 3, command: 'bogus' });
        await waitFor(() => session.lines.length >= 4, 'unknown command');
        assert.match(session.lines[3].error.message, /Unknown command/);

        session.send({ id: 4, command: 'read', args: ['notes/served.md'] });
        await waitFor(() => session.lines.length >= 5, 'read after unknown');
        assert.equal(session.lines[4].result.content, 'served\n');

        session.sendRaw('this is not json');
        await waitFor(() => session.lines.length >= 6, 'bad request');
        assert.equal(session.lines[5].error.code, 'FC_BAD_REQUEST');

        session.child.stdin.end();
        assert.equal(await session.exited, 0);
        assert.equal(session.stderr, '');
      } catch (error) {
        session.child.kill();
        throw error;
      }
    });

    await check('serve readonly rejects writes', async () => {
      const session = startServe(['--mode', 'readonly']);
      try {
        await waitFor(() => session.lines.length >= 1, 'ready');
        assert.equal(session.lines[0].mode, 'readonly');

        session.send({ id: 1, command: 'create', args: ['blocked-served.md'], options: { content: 'x', yes: true } });
        await waitFor(() => session.lines.length >= 2, 'readonly rejection');
        assert.equal(session.lines[1].error.code, 'FC_READ_ONLY');

        session.send({ id: 2, command: 'stat', args: ['notes/served.md'] });
        await waitFor(() => session.lines.length >= 3, 'readonly stat');
        assert.equal(session.lines[2].result.exists, true);

        session.child.stdin.end();
        assert.equal(await session.exited, 0);
        assert.equal(fs.existsSync(path.join(root, 'blocked-served.md')), false);
      } catch (error) {
        session.child.kill();
        throw error;
      }
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
