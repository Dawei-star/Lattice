import fs from 'node:fs';
import { VaultAdapter } from './vault.adapter.js';
import { rebuildProjection } from './indexer.js';

export function watchVault(vaultDir, { log = () => {}, delay = 180 } = {}) {
  const adapter = new VaultAdapter(vaultDir);
  let timer = null;
  let running = false;
  let pending = false;

  const sync = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const notes = await adapter.scan();
      rebuildProjection(notes);
      log({ notes: notes.length });
    } catch (error) {
      log({ error });
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(sync, delay);
  };

  fs.mkdirSync(vaultDir, { recursive: true });
  const watcher = fs.watch(vaultDir, { recursive: true }, (_event, filename) => {
    if (!filename || String(filename).includes('.lattice') || String(filename).endsWith('.tmp')) return;
    schedule();
  });

  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
