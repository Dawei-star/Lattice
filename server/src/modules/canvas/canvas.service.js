import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { resolveVaultPath } from '../../vault/path.js';

const FILE_PATH = '画板.canvas';
const vaultFile = () => resolveVaultPath(config.vaultDir, FILE_PATH, '.canvas');

export function read() {
  const file = vaultFile();
  if (!fs.existsSync(file)) return { nodes: [], edges: [] };
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { nodes: value.nodes ?? [], edges: value.edges ?? [] };
  } catch {
    return { nodes: [], edges: [] };
  }
}

export function write(document) {
  const file = vaultFile();
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
