#!/usr/bin/env node

import readline from 'node:readline/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createFileStore } from './fc-core.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  const positionals = [...parsed.positionals];
  const command = String(positionals.shift() ?? '').toLowerCase();
  const { options } = parsed;
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const root = options.root ?? env.FC_ROOT ?? env.VAULT_DIR ?? process.cwd();
  const store = createFileStore(root);
  let result;
  if (command === 'read') {
    result = store.read(positionals[0], { offset: options.offset, limit: options.limit });
  } else if (command === 'stat') {
    result = store.stat(positionals[0]);
  } else if (command === 'find') {
    result = store.find(positionals[0] ?? '**/*', positionals[1] ?? '', { type: options.type });
  } else if (command === 'grep') {
    result = store.grep(positionals[0], positionals[1] ?? '', { regex: options.regex, type: options.type });
  } else if (command === 'batch') {
    const plan = readBatchPlan(store, positionals[0]);
    const preview = store.previewBatch(plan.actions);
    if (options['plan-hash'] && options['plan-hash'] !== preview.planHash) {
      throw new Error(`Batch plan hash mismatch: expected ${options['plan-hash']}, current ${preview.planHash}`);
    }
    if (options['dry-run']) result = { dryRun: true, ...preview };
    else {
      await confirmBatch(preview, options.yes);
      result = store.mutateBatch(plan.actions, { planHash: preview.planHash });
    }
  } else if (command === 'log') {
    result = store.log(options.limit);
  } else if (command === 'undo') {
    result = store.undo(options.id ?? positionals[0] ?? null, { force: options.force });
  } else if (['create', 'write', 'append', 'edit', 'copy', 'move', 'delete', 'mkdir'].includes(command)) {
    const input = inputFor(command, positionals, options);
    const preview = store.previewMutation(command, input);
    if (options['dry-run']) result = { dryRun: true, ...preview };
    else {
      await confirm(preview, options.yes);
      result = store.mutate(command, input);
    }
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  const booleanOptions = new Set(['all', 'dry-run', 'force', 'help', 'h', 'regex', 'yes']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const key = arg.replace(/^-+/, '');
    if (booleanOptions.has(key)) options[key] = true;
    else {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`Option --${key} requires a value`);
      options[key] = value;
      index += 1;
    }
  }
  return { positionals, options };
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

async function confirm(preview, approved) {
  if (approved) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Write operation requires --yes in non-interactive mode');
  process.stderr.write(`${preview.summary}\n${preview.diff ? `${preview.diff}\n` : ''}`);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
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
  const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question('Apply batch? [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) throw new Error('Batch operation cancelled');
  } finally {
    prompt.close();
  }
}

function printHelp() {
  console.log(`fc - deterministic local file operations

Root: --root <dir>, then FC_ROOT, VAULT_DIR, or the current directory

Commands:
  read <path> [--offset n] [--limit n]
  stat <path>
  create <path> --content <text> [--dry-run] [--yes]
  write <path> --content <text> [--dry-run] [--yes]
  append <path> --content <text> [--dry-run] [--yes]
  edit <path> --replace <old> --with <new> [--all] [--dry-run] [--yes]
  copy <path> <target> [--dry-run] [--yes]
  move <path> <target> [--dry-run] [--yes]
  delete <path> [--dry-run] [--yes]
  mkdir <path> [--dry-run] [--yes]
  find [glob] [dir] [--type ext]
  grep <query> [dir] [--regex] [--type ext]
  batch <plan.json> [--dry-run] [--yes] [--plan-hash sha256]
  undo [operation-id] [--force]
  log [--limit n]

Mutating operations create .fc/trash snapshots and can be undone.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    const details = error.details ? { details: error.details } : {};
    process.stderr.write(`${JSON.stringify({ error: { message: error.message, code: error.code ?? 'FC_ERROR', ...details } })}\n`);
    process.exitCode = 1;
  });
}
