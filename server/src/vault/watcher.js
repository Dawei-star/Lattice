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

export function watchVault(vaultDir, { log = () => {}, onChange = () => {}, delay = 180 } = {}) {
  const adapter = new VaultAdapter(vaultDir);
  let timer = null;
  let flushing = false;
  /** @type {Set<string>} */
  const changedFiles = new Set();
  let structuralChange = false;

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
          if (result.added || result.updated || result.removed) onChange({ action: 'reconciled', ...result });
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
    if (filename === null) {
      // Windows 会报 null 文件名；无法定位文件，按结构变化处理
      structuralChange = true;
      schedule();
      return;
    }
    const name = String(filename).replaceAll('\\', '/');
    if (name.includes('.lattice') || name.startsWith('_templates/') || name.endsWith('.tmp')) return;
    if (name.toLowerCase().endsWith('.md')) changedFiles.add(name);
    else structuralChange = true; // 目录增删改名、资产文件等
    schedule();
  });

  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
