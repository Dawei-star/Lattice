'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Copy a Vault into a new timestamped directory without touching the source.
 * The destination is deliberately a sibling of the user-selected parent,
 * which makes the result easy to move to another machine or backup disk.
 */
async function copyVaultToBackup(vaultDir, parentDir, now = new Date()) {
  const source = path.resolve(vaultDir);
  const parent = path.resolve(parentDir);
  const sourceStat = await fs.promises.stat(source);
  if (!sourceStat.isDirectory()) throw new Error('知识库路径不是文件夹');

  const relativeParent = path.relative(source, parent);
  if (!relativeParent || (relativeParent !== '..' && !relativeParent.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeParent))) {
    throw new Error('备份目标不能位于当前知识库内部');
  }

  const parentStat = await fs.promises.stat(parent);
  if (!parentStat.isDirectory()) throw new Error('备份目标不是文件夹');

  const backupPath = nextBackupPath(parent, `lattice-backup-${formatTimestamp(now)}`);
  try {
    await fs.promises.cp(source, backupPath, { recursive: true, errorOnExist: true, force: false });
    const stats = await countFiles(backupPath);
    return { backupPath, ...stats };
  } catch (error) {
    await fs.promises.rm(backupPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function nextBackupPath(parent, baseName) {
  let suffix = 1;
  let candidate = path.join(parent, baseName);
  while (fs.existsSync(candidate)) {
    suffix += 1;
    candidate = path.join(parent, `${baseName}-${suffix}`);
  }
  return candidate;
}

async function countFiles(directory) {
  let fileCount = 0;
  let byteCount = 0;
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await countFiles(target);
      fileCount += nested.fileCount;
      byteCount += nested.byteCount;
    } else if (entry.isFile()) {
      fileCount += 1;
      byteCount += (await fs.promises.stat(target)).size;
    }
  }
  return { fileCount, byteCount };
}

function formatTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('备份时间无效');
  const pad = (part) => String(part).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('');
}

module.exports = { copyVaultToBackup, formatTimestamp };
