/**
 * Vault 文件监听。
 *
 * 此前任意文件事件都会触发「全库重扫 + 整库重建」；现在按事件类型分流：
 * - .md 文件事件 → 只对该文件做增量 upsert/删除（applyVaultChange）；
 * - 目录级 / 无法解析的事件（Windows 下 filename 可能为 null）→ 调度一次
 *   路径集合差量对齐（reconcileVault 的 membership 模式，不读已知文件内容）。
 * 同一批事件在防抖窗口内合并；应用层以 content_hash 兜底跳过未变化文件，
 * 因此同一文件被反复报告也不会产生写库。
 */
import fs from 'node:fs';
import { VaultAdapter } from './vault.adapter.js';
import { applyVaultChange, reconcileVault } from './sync.js';

/** vault 内部目录：与 VaultAdapter 的 SPECIAL_DIRS 保持一致。 */
const INTERNAL_DIRS = new Set(['.lattice', '.fc', '_templates']);

function isInternalPath(name) {
  if (INTERNAL_DIRS.has(name)) return true;
  for (const dir of INTERNAL_DIRS) {
    if (name.startsWith(`${dir}/`)) return true;
  }
  return false;
}

export function watchVault(vaultDir, { log = () => {}, onChange = () => {}, delay = 180 } = {}) {
  const adapter = new VaultAdapter(vaultDir);
  let timer = null;
  let flushing = false;
  /** @type {Set<string>} */
  const changedFiles = new Set();
  let structuralChange = false;
  // 业务侧多步磁盘操作（目录改名/删除）期间挂起 watcher：
  // 中间态事件不进投影，恢复时合并为一次收敛性对齐
  let suspended = false;
  let eventsWhileSuspended = false;

  const flush = async () => {
    if (flushing) return;
    flushing = true;
    try {
      const files = [...changedFiles];
      changedFiles.clear();
      const structural = structuralChange;
      structuralChange = false;

      for (const relativePath of files) {
        try {
          const result = await applyVaultChange(adapter, relativePath);
          log(result);
          if (result.action !== 'skipped' && result.action !== 'absent') onChange(result);
        } catch (error) {
          log({ error, file: relativePath });
        }
      }
      if (structural) {
        try {
          const result = await reconcileVault(adapter, { mode: 'membership' });
          log(result);
          // 即使笔记投影零变化也要广播：非笔记文件（附件等）的新增删除
          // 不影响 notes 表，但前端「显示附件」列表依赖这条事件刷新。
          onChange({ action: 'reconciled', ...result });
        } catch (error) {
          log({ error });
        }
      }
    } finally {
      flushing = false;
      // 处理期间又有新事件：再排一轮，保证最终收敛
      if (changedFiles.size > 0 || structuralChange) schedule();
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      flush().catch((error) => log({ error }));
    }, delay);
  };

  fs.mkdirSync(vaultDir, { recursive: true });
  const watcher = fs.watch(vaultDir, { recursive: true }, (_event, filename) => {
    if (suspended) {
      eventsWhileSuspended = true;
      return;
    }
    if (filename === null) {
      // Windows 会报 null 文件名；无法定位文件，按结构变化处理
      structuralChange = true;
      schedule();
      return;
    }
    const name = String(filename).replaceAll('\\', '/');
    // 只按路径段前缀排除内部目录，避免误伤 my.lattice.md 这类合法文件名。
    // 清单必须与 VaultAdapter.SPECIAL_DIRS 一致（.lattice/.fc/_templates），
    // 否则 reconcile 不扫的文件会被事件路径写进投影，产生幽灵笔记。
    if (isInternalPath(name) || name.endsWith('.tmp')) return;
    if (name.toLowerCase().endsWith('.md')) changedFiles.add(name);
    else structuralChange = true; // 目录增删改名、资产文件等
    schedule();
  });

  const stop = () => {
    clearTimeout(timer);
    watcher.close();
  };
  /** 挂起期间事件只做标记；恢复时若有积压事件，调度一次收敛性对齐 */
  stop.suspend = () => {
    suspended = true;
  };
  stop.resume = () => {
    if (!suspended) return;
    suspended = false;
    if (eventsWhileSuspended) {
      eventsWhileSuspended = false;
      structuralChange = true;
      schedule();
    }
  };
  return stop;
}
