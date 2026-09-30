import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { resolveVaultPath } from '../../vault/path.js';
import { VaultAdapter } from '../../vault/vault.adapter.js';

const FILE_PATH = '画板.canvas';
const vaultFile = (filePath = FILE_PATH) => resolveVaultPath(config.vaultDir, filePath, '.canvas');
const vaultGuard = new VaultAdapter(config.vaultDir);

const hashRaw = (raw) => createHash('sha256').update(raw).digest('hex');

export function list() {
  const files = [];
  walkCanvasFiles(config.vaultDir, '', files);
  return files.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
}

export async function read(filePath = FILE_PATH) {
  const file = vaultFile(filePath);
  let raw = null;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (raw === null) return { nodes: [], edges: [], revision: null };
  const value = parseCanvasDocument(raw, filePath);
  return { nodes: value.nodes, edges: value.edges, revision: hashRaw(raw) };
}

export async function write(document, filePath = FILE_PATH) {
  const { expectedHash, ...payload } = document ?? {};
  const file = vaultFile(filePath);

  let currentRaw = null;
  try {
    currentRaw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // 乐观锁：客户端带上 GET 返回的 revision，磁盘已变则拒绝，避免 last-write-wins 丢数据
  if (expectedHash && currentRaw !== null && hashRaw(currentRaw) !== expectedHash) {
    throw new ConflictError('画布已被其他操作修改，请重新加载后再保存');
  }

  const raw = `${JSON.stringify({ ...payload, version: 1 }, null, 2)}\n`;
  await vaultGuard.assertWritablePath(file);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, raw, 'utf8');
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  return { ...payload, revision: hashRaw(raw) };
}

export function move(fromPath, toPath) {
  const source = vaultFile(fromPath);
  const target = vaultFile(toPath);
  if (!fs.existsSync(source)) throw new NotFoundError('画布文件不存在');
  if (source !== target && fs.existsSync(target)) throw new ConflictError('目标位置已存在同名画布文件');

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (source !== target) fs.renameSync(source, target);
  return { fromPath, toPath };
}

function parseCanvasDocument(raw, filePath) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ValidationError('Canvas file contains invalid JSON', [{ field: 'path', message: filePath }]);
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new ValidationError('Canvas file has an invalid structure');
  }
  return value;
}

function walkCanvasFiles(root, relativeDir, result) {
  if (!fs.existsSync(root)) return;
  const absoluteDir = path.join(root, relativeDir);
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.name === '.lattice' || entry.name.startsWith('.')) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkCanvasFiles(root, relativePath, result);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.canvas')) {
      const folderPath = relativeDir.replaceAll('\\', '/');
      result.push({
        path: relativePath.replaceAll('\\', '/'),
        name: entry.name,
        folderPath,
      });
    }
  }
}
