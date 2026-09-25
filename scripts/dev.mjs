#!/usr/bin/env node
/**
 * 零依赖开发启动器：并行拉起后端 API 与前端 Vite Dev Server。
 * 任一子进程退出即整体退出；Ctrl+C 时转发信号做优雅停机。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const PALETTE = { server: '\x1b[36m', web: '\x1b[35m', reset: '\x1b[0m' };

/** @type {Array<{name: string, cwd: string, args: string[]}>} */
const targets = [
  { name: 'server', cwd: path.join(root, 'server'), args: ['run', 'dev'] },
  { name: 'web', cwd: path.join(root, 'web'), args: ['run', 'dev'] },
];

const children = [];
let shuttingDown = false;

for (const target of targets) {
  const child = spawn(npm, target.args, {
    cwd: target.cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  children.push(child);

  const tag = `${PALETTE[target.name]}[${target.name}]${PALETTE.reset} `;
  const forward = (stream) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(tag + line + '\n');
    });
  };
  forward(child.stdout);
  forward(child.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${tag}进程退出，退出码 ${code}，正在关闭其余进程…\n`);
    shutdown(code ?? 0);
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

process.stdout.write('\n  格物 Lattice 开发模式启动中…\n');
process.stdout.write('    后端 API   http://localhost:5177\n');
process.stdout.write('    前端界面   http://localhost:5173\n\n');
