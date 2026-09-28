import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { resolveVaultPath } from '../../vault/path.js';

const FILE_PATH = '画板.canvas';
const vaultFile = (filePath = FILE_PATH) => resolveVaultPath(config.vaultDir, filePath, '.canvas');

export function list() {
  const files = [];
  walkCanvasFiles(config.vaultDir, '', files);
  return files.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
}

export function read(filePath = FILE_PATH) {
  const file = vaultFile(filePath);
  if (!fs.existsSync(file)) return { nodes: [], edges: [] };
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
      throw new ValidationError('Canvas file has an invalid structure');
    }
    return { nodes: value.nodes ?? [], edges: value.edges ?? [] };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('Canvas file contains invalid JSON', [{ field: 'path', message: filePath }]);
  }
}

export function write(document, filePath = FILE_PATH) {
  const file = vaultFile(filePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ ...document, version: 1 }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return document;
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
