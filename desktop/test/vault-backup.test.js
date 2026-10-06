'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { copyVaultToBackup, formatTimestamp } = require('../src/vault-backup.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-vault-backup-'));
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'backups');
  fs.mkdirSync(path.join(vault, '.lattice', 'history', 'note-1'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'attachments'), { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(vault, '笔记.md'), '# 内容\n', 'utf8');
  fs.writeFileSync(path.join(vault, 'attachments', 'image.txt'), 'asset', 'utf8');
  fs.writeFileSync(path.join(vault, '.lattice', 'history', 'note-1', '1.md'), 'old', 'utf8');
  return { root, vault, target };
}

test('formatTimestamp creates a filesystem-safe local timestamp', () => {
  assert.equal(formatTimestamp(new Date(2026, 9, 1, 8, 4, 6)), '20261001-080406');
});

test('copyVaultToBackup copies content, attachments, and history', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const result = await copyVaultToBackup(data.vault, data.target, new Date(2026, 9, 1, 8, 4, 6));
  assert.equal(result.backupPath, path.join(data.target, 'lattice-backup-20261001-080406'));
  assert.equal(result.fileCount, 3);
  assert.equal(result.byteCount, 9 + 5 + 3);
  assert.equal(fs.readFileSync(path.join(result.backupPath, '笔记.md'), 'utf8'), '# 内容\n');
  assert.equal(fs.readFileSync(path.join(result.backupPath, '.lattice', 'history', 'note-1', '1.md'), 'utf8'), 'old');
});

test('repeated backups in the same second receive a unique directory', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const timestamp = new Date(2026, 9, 1, 8, 4, 6);
  const first = await copyVaultToBackup(data.vault, data.target, timestamp);
  const second = await copyVaultToBackup(data.vault, data.target, timestamp);
  assert.equal(path.basename(first.backupPath), 'lattice-backup-20261001-080406');
  assert.equal(path.basename(second.backupPath), 'lattice-backup-20261001-080406-2');
});

test('backup cannot be created inside the source Vault', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  await assert.rejects(() => copyVaultToBackup(data.vault, path.join(data.vault, 'backups')), /不能位于当前知识库内部/);
});

test('desktop exposes the backup bridge and IPC handler', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
    assert.match(mainSource, /handleIpc\('vault:backup'/);
    assert.match(mainSource, /copyVaultToBackup\(vaultDir/);
    assert.match(preloadSource, /backupVault: \(\) => ipcRenderer\.invoke\('vault:backup'\)/);
    assert.match(mainSource, /handleIpc\('vault:export-static-site'/);
    assert.match(preloadSource, /exportStaticSite: \(files\) => ipcRenderer\.invoke\('vault:export-static-site', files\)/);
  });
