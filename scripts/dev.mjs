import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 直接用当前 Node 运行底层脚本，而不是 spawn npm.cmd：
// 1) Windows 自 Node 安全加固（CVE-2024-27980）后，直接 spawn .cmd 会抛 EINVAL；
// 2) shell:true 会引入 cmd.exe → npm → node 三层包装，命令行参数可能被吞，
//    且包装层退出后真正的 server/vite 进程会变成孤儿，占死 5177/5173 端口。
// 与根 package.json 的 dev:server / dev:web 脚本保持一致，改动脚本时需同步这里。
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

function treeKill(child) {
  if (!child.pid) return;
  if (isWin) {
    // Windows 没有 POSIX 信号语义，TerminateProcess 只杀直接子进程；
    // node --watch 内层还挂着真正的 server 子进程，必须 taskkill /T 整树结束。
    // windowsHide 避免每次 Ctrl+C 闪控制台窗口；error 监听防止 taskkill
    // 启动失败（PATH 异常等）以 uncaught exception 打断关机流程。
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .on('error', () => {
        child.kill('SIGKILL');
      });
  } else {
    child.kill('SIGINT');
  }
}

let shuttingDown = false;

const shutdown = (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) treeKill(child);
  // taskkill 是异步派生的，留一小段宽限让它真正发出，再硬退整个 dev 进程：
  // 否则子进程不肯退（或 taskkill 失败）时父进程会挂死不退出
  setTimeout(() => process.exit(exitCode), 500);
};

for (const child of children) {
  child.on('error', (err) => {
    if (!shuttingDown) {
      console.error(`[dev] 子进程启动失败: ${err.message}`);
      shutdown(1);
    }
  });
  child.on('exit', (code) => {
    if (shuttingDown) return;
    if (code !== 0) {
      // 一个子进程异常退出（例如端口被占用），立即结束另一个，避免留下孤儿服务。
      shutdown(code ?? 1);
    }
  });
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
