/**
 * 预先占住 Node fetch（undici）屏蔽的端口，避免测试随机端口撞上它。
 *
 * 背景：Windows 的动态端口范围在这台机器上是从 1024 起（`netsh int ipv4 show dynamicport tcp`），
 * 而 undici 拒绝连接一批「危险端口」（6000、6665-6669、6679、6697、10080、1719-2049 中的若干 …）。
 * 测试普遍用 `server.listen(0)` 拿随机端口再 `fetch` 自己，一旦被分配到这些端口，就是
 * `TypeError: fetch failed` + `[cause]: Error: bad port` —— 表现为随机失败、重跑又过的「环境抖动」。
 * 实测：连续占用 3000 个端口扫描，占住前命中 4 个屏蔽端口，占住后 0 个。
 *
 * 做法：进程启动时把屏蔽端口绑在 127.0.0.1 上并 `unref()`（不阻止进程退出、也不影响
 * 事件循环），OS 就不会再把它们当临时端口分配出去。端口已被别的程序占用时跳过即可。
 *
 * 由 `server` 的 test 脚本通过 `--import` 加载；只影响测试进程。
 */
import net from 'node:net';

/** 取自 undici 的 badPorts，仅保留落在本机动态端口区间（1024-15000）内的部分。 */
const BLOCKED_PORTS = Object.freeze([
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const reserved = [];

for (const port of BLOCKED_PORTS) {
  const server = net.createServer();
  // 端口被别人占着（或系统不允许）时静默跳过：那不是我们能控制的
  server.on('error', () => server.close());
  server.listen(port, '127.0.0.1', () => {
    server.unref();
    reserved.push(server);
  });
}

process.once('exit', () => {
  for (const server of reserved) server.close();
});

export const RESERVED_BLOCKED_PORTS = BLOCKED_PORTS;
