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
  const value = normalizeCanvasDocument(parseCanvasDocument(raw, filePath));
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

export async function remove(filePath) {
  const file = vaultFile(filePath);
  // 幂等：文件已不在磁盘（如被外部删除、树列表过期）时按成功处理，让前端能把过期条目清掉
  if (!fs.existsSync(file)) return { path: filePath, deleted: true };
  await vaultGuard.assertWritablePath(file);
  await fsp.unlink(file);
  return { path: filePath, deleted: true };
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

// ── Obsidian 画布兼容 ────────────────────────────────────────
// Obsidian 的 .canvas 与本项目格式有三处不兼容，读取时统一归一化：
//   1. edge 用 fromNode/toNode（本项目用 from/to），fromSide/toSide 恰好同名；
//   2. 节点颜色是 "1"~"6" 或 #hex（本项目用命名色），且 edge 也带颜色；
//   3. 存在 group/link 节点类型，group 无 text 只有 label。
// 归一化发生在读取时：首次保存后文件即落为本项目格式。
const OBSIDIAN_NAMED_COLORS = { 1: 'red', 2: 'orange', 3: 'yellow', 4: 'green', 5: 'blue', 6: 'purple' };
const CARD_COLOR_HUES = { red: 0, orange: 30, yellow: 55, green: 130, blue: 220, purple: 285 };

function normalizeCanvasDocument(value) {
  const nodes = value.nodes.map(normalizeCanvasNode).filter(Boolean);
  const nodeIds = new Set(nodes.map((node) => node.id));
  // group 节点在 Obsidian 里垫底，渲染顺序按 DOM 先后，因此排到最前
  const orderedNodes = [
    ...nodes.filter((node) => node.type === 'group'),
    ...nodes.filter((node) => node.type !== 'group'),
  ];
  const edges = value.edges
    .map(normalizeCanvasEdge)
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  return { ...value, nodes: orderedNodes, edges };
}

function normalizeCanvasNode(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const node = { ...raw };
  if (node.type === 'group') {
    node.text = typeof node.text === 'string' ? node.text : (typeof node.label === 'string' ? node.label : '');
    delete node.label;
  } else if (node.type === 'link') {
    // 链接节点没有本地对应物，降级为记录 URL 的文本卡片
    node.type = 'text';
    node.text = typeof node.url === 'string' ? node.url : '';
  } else if (!node.type) {
    node.type = 'text';
  }
  // Obsidian 的 file/image 节点用 file 字段存 Vault 相对路径；本项目图片节点用 path
  if ((node.type === 'image' || node.type === 'file') && typeof node.file === 'string' && !node.path) {
    node.path = node.file;
  }
  if (typeof node.text !== 'string') {
    const source = typeof node.file === 'string' ? node.file : '';
    node.text = source ? source.split('/').pop().replace(/\.md$/i, '') : '';
  }
  const color = normalizeCanvasColor(node.color);
  if (color === null) delete node.color;
  else node.color = color;
  return node;
}

function normalizeCanvasEdge(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const from = typeof raw.from === 'string' ? raw.from : raw.fromNode;
  const to = typeof raw.to === 'string' ? raw.to : raw.toNode;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const { fromNode: _fromNode, toNode: _toNode, ...rest } = raw;
  const edge = { ...rest, from, to };
  const color = normalizeCanvasColor(edge.color);
  if (color === null) delete edge.color;
  else edge.color = color;
  return edge;
}

/** Obsidian 颜色（"1"~"6" / #hex / {rgb} 对象）→ 本项目命名色；无法识别时移除该字段。 */
function normalizeCanvasColor(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return normalizeCanvasColor(value.rgb);
  if (typeof value !== 'string') return null;
  if (OBSIDIAN_NAMED_COLORS[value]) return OBSIDIAN_NAMED_COLORS[value];
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return nearestCardColor(value);
  return CARD_COLOR_HUES[value] !== undefined ? value : null;
}

function nearestCardColor(hex) {
  const expanded = hex.length === 4 ? `#${[...hex.slice(1)].map((ch) => ch + ch).join('')}` : hex;
  const channel = (offset) => parseInt(expanded.slice(1 + offset, 3 + offset), 16) / 255;
  const [r, g, b] = [channel(0), channel(2), channel(4)];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.12) return max > 0.6 ? 'yellow' : 'blue';
  let hue;
  if (max === r) hue = ((g - b) / (max - min)) * 60;
  else if (max === g) hue = 120 + ((b - r) / (max - min)) * 60;
  else hue = 240 + ((r - g) / (max - min)) * 60;
  if (hue < 0) hue += 360;
  let best = 'blue';
  let bestDistance = Infinity;
  for (const [name, candidateHue] of Object.entries(CARD_COLOR_HUES)) {
    const distance = Math.min(Math.abs(hue - candidateHue), 360 - Math.abs(hue - candidateHue));
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
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
