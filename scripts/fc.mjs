#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFileStore } from './fc-core.mjs';

const WRITE_COMMANDS = new Set(['create', 'write', 'append', 'edit', 'copy', 'move', 'delete', 'mkdir', 'batch', 'undo']);
const BOOLEAN_OPTIONS = new Set(['all', 'dry-run', 'force', 'help', 'h', 'regex', 'yes', 'V', 'version']);
const MODES = new Set(['default', 'readonly']);
const EXIT_SLASH_COMMANDS = new Set(['/exit', '/quit', '/q']);

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  const positionals = [...parsed.positionals];
  const command = String(positionals.shift() ?? '').toLowerCase();
  const { options } = parsed;

  if (options.version || options.V) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'help') {
    printCommandHelp(positionals[0]);
    return;
  }

  const mode = resolveMode(options, env);
  const root = options.root ?? env.FC_ROOT ?? env.VAULT_DIR ?? process.cwd();
  const store = createFileStore(root);

  if (command === 'shell') {
    await runShell(store, { mode });
    return;
  }
  if (command === 'serve') {
    await runServe(store, { mode });
    return;
  }

  const result = await executeCommand(store, command, positionals, options, { mode });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (command === 'doctor' && result.ok === false) process.exitCode = 1;
}

async function executeCommand(store, command, positionals, options, context) {
  if (context.mode === 'readonly' && WRITE_COMMANDS.has(command) && !options['dry-run']) throw readOnlyError(command);
  if (command === 'read') {
    return store.read(positionals[0], { offset: options.offset, limit: options.limit });
  }
  if (command === 'stat') {
    return store.stat(positionals[0]);
  }
  if (command === 'find') {
    return store.find(positionals[0] ?? '**/*', positionals[1] ?? '', { type: options.type });
  }
  if (command === 'grep') {
    return store.grep(positionals[0], positionals[1] ?? '', { regex: options.regex, type: options.type });
  }
  if (command === 'batch') {
    const plan = readBatchPlan(store, positionals[0]);
    const preview = store.previewBatch(plan.actions);
    if (options['plan-hash'] && options['plan-hash'] !== preview.planHash) {
      throw new Error(`Batch plan hash mismatch: expected ${options['plan-hash']}, current ${preview.planHash}`);
    }
    if (options['dry-run']) return { dryRun: true, ...preview };
    await confirmBatch(preview, options.yes);
    return store.mutateBatch(plan.actions, { planHash: preview.planHash });
  }
  if (command === 'log') {
    return store.log(options.limit);
  }
  if (command === 'undo') {
    // --dry-run 的约定是「只看不做」：undo 没有预览形态，直接不执行。
    // 否则 readonly 模式下 `fc undo --dry-run` 会绕过只读门真实回滚文件
    if (options['dry-run']) {
      const target = options.id ?? positionals[0] ?? null;
      return target ? { dryRun: true, operationId: target } : { dryRun: true };
    }
    return store.undo(options.id ?? positionals[0] ?? null, { force: options.force });
  }
  if (command === 'doctor') {
    return inspectHealth(store);
  }
  if (WRITE_COMMANDS.has(command)) {
    const input = inputFor(command, positionals, options);
    const preview = store.previewMutation(command, input);
    if (options['dry-run']) return { dryRun: true, ...preview };
    await confirm(preview, options.yes);
    return store.mutate(command, input, { planHash: preview.planHash });
  }
  throw new Error(`Unknown command: ${command}`);
}

async function runShell(store, { mode }) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: interactive,
    ...(interactive ? { output: process.stderr } : {}),
  });
  let executed = 0;
  let failed = 0;
  if (interactive) {
    process.stderr.write(`fc shell ${readVersion()} — root ${store.rootDir} (mode ${mode}); /help for built-ins, /exit to leave\n`);
    rl.setPrompt('fc> ');
    rl.prompt();
  }
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      if (interactive) rl.prompt();
      continue;
    }
    if (EXIT_SLASH_COMMANDS.has(trimmed.toLowerCase())) break;
    try {
      if (trimmed.toLowerCase() === '/help') {
        printHelp();
      } else if (trimmed.startsWith('/')) {
        failed += 1;
        writeError(new Error(`Unknown slash command: ${trimmed} (available: /help, /exit)`));
      } else {
        const parsed = parseArgs(tokenizeLine(trimmed));
        const lineCommand = String(parsed.positionals.shift() ?? '').toLowerCase();
        if (lineCommand) {
          const result = await executeCommand(store, lineCommand, parsed.positionals, parsed.options, { mode });
          executed += 1;
          process.stdout.write(`${JSON.stringify(result)}\n`);
        }
      }
    } catch (error) {
      failed += 1;
      writeError(error);
    }
    if (interactive) rl.prompt();
  }
  rl.close();
  process.stdout.write(`${JSON.stringify({ event: 'exit', commands: executed, errors: failed })}\n`);
}

async function runServe(store, { mode }) {
  process.stdout.write(`${JSON.stringify({ event: 'ready', version: readVersion(), root: store.rootDir, mode })}\n`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request = null;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      respondError(null, badRequest(`Invalid request JSON: ${error.message}`));
      continue;
    }
    const id = typeof request?.id === 'string' || typeof request?.id === 'number' ? request.id : null;
    try {
      if (request?.command === 'ping') {
        respondResult(id, { pong: true, root: store.rootDir, mode });
        continue;
      }
      const args = Array.isArray(request?.args) ? request.args.map((value) => String(value)) : [];
      const options = request?.options && typeof request?.options === 'object' && !Array.isArray(request.options) ? request.options : {};
      const command = String(request?.command ?? '').toLowerCase();
      const result = await executeCommand(store, command, args, options, { mode });
      respondResult(id, result);
    } catch (error) {
      respondError(id, error);
    }
  }
  rl.close();
}

function inspectHealth(store) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  let rootIsDirectory = false;
  try {
    rootIsDirectory = fs.statSync(store.rootDir).isDirectory();
  } catch {
    rootIsDirectory = false;
  }
  add('root', rootIsDirectory, rootIsDirectory ? String(store.rootDir) : `missing or not a directory: ${store.rootDir}`);

  if (rootIsDirectory) {
    const probe = path.join(store.rootDir, `.fc-doctor-${randomUUID().slice(0, 8)}.tmp`);
    try {
      fs.writeFileSync(probe, '');
      fs.rmSync(probe, { force: true });
      add('writable', true, 'root accepts writes');
    } catch (error) {
      add('writable', false, `root is not writable: ${error.message}`);
    }
  }

  if (fs.existsSync(store.auditFile)) {
    try {
      const lines = fs.readFileSync(store.auditFile, 'utf8').split(/\r?\n/).filter(Boolean);
      let malformed = 0;
      for (const line of lines) {
        try {
          JSON.parse(line);
        } catch {
          malformed += 1;
        }
      }
      add('audit', true, `${lines.length - malformed} entries${malformed ? `, ${malformed} malformed line${malformed === 1 ? '' : 's'} (skipped by log)` : ''}`);
    } catch (error) {
      add('audit', false, `audit log unreadable: ${error.message}`);
    }
  } else {
    add('audit', true, 'no audit log yet (no mutations recorded)');
  }

  const trashProblems = [];
  let operations = 0;
  let pending = 0;
  if (fs.existsSync(store.trashDir)) {
    let directories = [];
    try {
      directories = fs.readdirSync(store.trashDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch (error) {
      trashProblems.push(`trash directory unreadable: ${error.message}`);
    }
    for (const directory of directories) {
      operations += 1;
      const manifest = readManifest(path.join(store.trashDir, directory.name, 'manifest.json'));
      if (!manifest) {
        trashProblems.push(`manifest unreadable: ${directory.name}`);
        continue;
      }
      if (manifest.undoneAt) continue;
      pending += 1;
      for (const entry of manifest.entries ?? []) {
        if (entry.snapshot && !fs.existsSync(path.join(store.trashDir, directory.name, 'files', entry.snapshot))) {
          trashProblems.push(`snapshot missing for pending undo ${directory.name}: ${entry.path}`);
        }
      }
    }
  }
  add('trash', trashProblems.length === 0, trashProblems.length ? trashProblems.join('; ') : `${operations} operations, ${pending} pending undo`);

  return { root: store.rootDir, ok: checks.every((check) => check.ok), checks };
}

function inputFor(command, positionals, options) {
  if (command === 'copy' || command === 'move') return { path: positionals[0], targetPath: positionals[1] };
  if (command === 'edit') return { path: positionals[0], replace: options.replace, with: options.with, all: options.all };
  if (command === 'create' || command === 'write' || command === 'append') return { path: positionals[0], content: options.content };
  return { path: positionals[0] };
}

function parseArgs(args) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const key = arg.replace(/^-+/, '');
    if (BOOLEAN_OPTIONS.has(key)) options[key] = true;
    else {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`Option --${key} requires a value`);
      options[key] = value;
      index += 1;
    }
  }
  return { positionals, options };
}

function tokenizeLine(line) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (quote) throw new Error('Unclosed quote in command line');
  if (current) tokens.push(current);
  return tokens;
}

function resolveMode(options, env) {
  const mode = String(options.mode ?? env.FC_MODE ?? 'default').toLowerCase();
  if (!MODES.has(mode)) throw new Error(`Unknown mode: ${mode} (expected default or readonly)`);
  return mode;
}

function readOnlyError(command) {
  const error = new Error(`fc is in readonly mode: ${command} is not allowed`);
  error.code = 'FC_READ_ONLY';
  return error;
}

function badRequest(message) {
  const error = new Error(message);
  error.code = 'FC_BAD_REQUEST';
  return error;
}

function errorPayload(error) {
  const payload = { message: error.message, code: error.code ?? 'FC_ERROR' };
  if (error.details) payload.details = error.details;
  return payload;
}

function respondResult(id, result) {
  process.stdout.write(`${JSON.stringify({ ...(id === null ? {} : { id }), result })}\n`);
}

function respondError(id, error) {
  process.stdout.write(`${JSON.stringify({ ...(id === null ? {} : { id }), error: errorPayload(error) })}\n`);
}

function writeError(error) {
  process.stderr.write(`${JSON.stringify({ error: errorPayload(error) })}\n`);
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function readBatchPlan(store, planPath) {
  if (!planPath) throw new Error('batch requires a plan file');
  const plan = store.read(planPath);
  if (!plan.eof) throw new Error('Batch plan is larger than the 2 MiB plan limit');
  let parsed;
  try {
    parsed = JSON.parse(plan.content);
  } catch (error) {
    throw new Error(`Invalid batch plan JSON: ${error.message}`);
  }
  const actions = Array.isArray(parsed) ? parsed : parsed?.actions;
  if (!Array.isArray(actions) || actions.length === 0) throw new Error('Batch plan must contain a non-empty actions array');
  return { actions };
}

function readManifest(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function confirm(preview, approved) {
  if (approved) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Write operation requires --yes in non-interactive mode');
  process.stderr.write(`${preview.summary}\n${preview.diff ? `${preview.diff}\n` : ''}`);
  const prompt = readlinePromises.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question('Apply operation? [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) throw new Error('Operation cancelled');
  } finally {
    prompt.close();
  }
}

async function confirmBatch(preview, approved) {
  if (approved) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Batch write operation requires --yes in non-interactive mode');
  process.stderr.write(`${preview.summary} [plan ${preview.planHash}]\n`);
  for (const operation of preview.operations) {
    process.stderr.write(`- ${operation.summary}\n${operation.diff ? `${operation.diff}\n` : ''}`);
  }
  const prompt = readlinePromises.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question('Apply batch? [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) throw new Error('Batch operation cancelled');
  } finally {
    prompt.close();
  }
}

const COMMAND_HELP = {
  read: 'read <path> [--offset n] [--limit n]\n\n  Return up to 2 MiB of file content as JSON. offset/limit are character counts; eof tells whether the end was reached.',
  stat: 'stat <path>\n\n  Metadata for one path: exists, type, size, sha256, modifiedAt. Missing paths report exists:false instead of failing.',
  find: 'find [glob] [dir] [--type ext]\n\n  List files matching a glob (default **/*) under dir. --type filters by extension.',
  grep: 'grep <query> [dir] [--regex] [--type ext]\n\n  Search file contents line by line. --regex treats the query as a case-insensitive regular expression.',
  log: 'log [--limit n]\n\n  Last n audit entries (default 40, max 500), newest first.',
  doctor: 'doctor\n\n  Health-check the root: directory exists and is writable, audit log is parseable, undo manifests and snapshots are intact. Exits 1 when a check fails.',
  create: 'create <path> --content <text> [--dry-run] [--yes]\n\n  Create a new file. Fails if the path already exists. --dry-run previews the diff; --yes skips the interactive confirmation.',
  write: 'write <path> --content <text> [--dry-run] [--yes]\n\n  Replace the whole content of an existing file.',
  append: 'append <path> --content <text> [--dry-run] [--yes]\n\n  Add text at the end of an existing file.',
  edit: 'edit <path> --replace <old> --with <new> [--all] [--dry-run] [--yes]\n\n  Exact text replacement. Fails when <old> occurs multiple times unless --all is given.',
  copy: 'copy <path> <target> [--dry-run] [--yes]\n\n  Copy a file; the target must not exist.',
  move: 'move <path> <target> [--dry-run] [--yes]\n\n  Rename/move a file; the target must not exist.',
  delete: 'delete <path> [--dry-run] [--yes]\n\n  Delete a file after snapshotting it to .fc/trash (undo can restore it).',
  mkdir: 'mkdir <path> [--dry-run] [--yes]\n\n  Create a directory (recursively).',
  batch: 'batch <plan.json> [--dry-run] [--yes] [--plan-hash sha256]\n\n  Execute a plan of actions atomically-ish: {"actions":[{"type":"write","path":"a.md","content":"..."}, ...]}. --plan-hash pins the previewed plan so it cannot be swapped between preview and execution.',
  undo: 'undo [operation-id] [--force]\n\n  Restore the files an operation touched to their pre-operation state. Refuses when a file changed afterwards; --force overrides.',
  shell: 'shell\n\n  Interactive session: plain fc commands one per line, plus /help and /exit. # starts a comment line. Piped input works too, so scripts can batch commands through one process.',
  serve: 'serve\n\n  JSON-lines service on stdio for automation clients. Each request line: {"id":1,"command":"read","args":["a.md"],"options":{"offset":0}}; each response line: {"id":1,"result":...} or {"id":1,"error":{...}}. A ready event is emitted at startup; ping returns liveness. Unknown commands are reported per request without stopping the service.',
};

function printHelp() {
  console.log(`fc - deterministic local file operations

Usage: fc <command> [args] [options]      (run \`fc help <command>\` for details)

Root: --root <dir>, then FC_ROOT, VAULT_DIR, or the current directory
Mode: --mode default|readonly (or FC_MODE); readonly refuses every mutation, undo included

Read-only commands
  read <path> [--offset n] [--limit n]
  stat <path>
  find [glob] [dir] [--type ext]
  grep <query> [dir] [--regex] [--type ext]
  log [--limit n]
  doctor                          health-check root, audit log, and undo snapshots

Mutating commands (snapshot to .fc/trash, reversible with undo)
  create <path> --content <text> [--dry-run] [--yes]
  write <path> --content <text> [--dry-run] [--yes]
  append <path> --content <text> [--dry-run] [--yes]
  edit <path> --replace <old> --with <new> [--all] [--dry-run] [--yes]
  copy <path> <target> [--dry-run] [--yes]
  move <path> <target> [--dry-run] [--yes]
  delete <path> [--dry-run] [--yes]
  mkdir <path> [--dry-run] [--yes]
  batch <plan.json> [--dry-run] [--yes] [--plan-hash sha256]
  undo [operation-id] [--force]

Sessions
  shell                           interactive session (plain commands + /help /exit; piped input works)
  serve                           JSON-lines service on stdio for automation clients

Other: -V/--version, help <command>`);
}

function printCommandHelp(name) {
  if (!name) {
    printHelp();
    return;
  }
  const entry = COMMAND_HELP[String(name).toLowerCase()];
  if (!entry) throw new Error(`No help available for: ${name}`);
  console.log(`fc ${entry}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    writeError(error);
    process.exitCode = 1;
  });
}
