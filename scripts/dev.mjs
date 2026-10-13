import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === 'win32';

const children = [
  spawn(
    process.execPath,
    ['--watch', '--disable-warning=ExperimentalWarning', '--env-file-if-exists=.env', 'src/index.js'],
    { cwd: path.join(root, 'server'), stdio: 'inherit', env: process.env },
  ),
  spawn(
    process.execPath,
    [path.join(root, 'web', 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1'],
    { cwd: path.join(root, 'web'), stdio: 'inherit', env: process.env },
  ),
];

function stopChild(child) {
  if (!child.pid) return;
  if (isWin) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => child.kill('SIGKILL'));
  } else {
    child.kill('SIGINT');
  }
}

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) stopChild(child);
  setTimeout(() => process.exit(exitCode), 500);
}

for (const child of children) {
  child.on('error', (error) => {
    if (!shuttingDown) {
      console.error(`[dev] 子进程启动失败: ${error.message}`);
      shutdown(1);
    }
  });
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) shutdown(code ?? 1);
  });
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
