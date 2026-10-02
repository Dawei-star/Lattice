/**
 * watcher 控制句柄注册表。
 *
 * index.js 启动时把 watchVault 返回的句柄注册进来，业务模块（目录改名/删除）
 * 在多步磁盘操作期间调用 suspend/resume 挂起 watcher——否则 watcher 会把
 * 「新路径出现 + 旧路径消失」的中间态写进投影，与 DB 事务交错产生脏数据。
 * watcher 未启动（部分测试/CLI 场景）时全部为空操作。
 */
let handle = null;

export function registerWatcherControl(next) {
  handle = next;
}

export function suspendWatcher() {
  handle?.suspend?.();
}

export function resumeWatcher() {
  handle?.resume?.();
}
