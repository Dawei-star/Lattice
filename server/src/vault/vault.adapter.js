import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeVaultRelativePath, resolveVaultPath, sanitizeFilePart } from './path.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from './markdown.js';

const INTERNAL_DIR = '.lattice';

export class VaultAdapter {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
  }

  async ensure() {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  ensureDirectorySync(relativePath) {
    fsSync.mkdirSync(this.resolveDirectory(relativePath), { recursive: true });
  }

  async scan() {
    await this.ensure();
    const files = [];
    await walk(this.rootDir, '', files);
    const notes = [];
    const ids = new Set();
    for (const relativePath of files) {
      const raw = await fs.readFile(resolveVaultPath(this.rootDir, relativePath), 'utf8');
      const note = parseMarkdownDocument(raw, relativePath);
      if (!note.hasFrontmatter || ids.has(note.id)) {
        // Copied Markdown files can carry the same legacy id; make each file addressable.
        if (ids.has(note.id)) note.id = randomUUID();
        await this.write(note);
      }
      ids.add(note.id);
      notes.push(note);
    }
    return notes;
  }

  async scanFolders() {
    await this.ensure();
    const folders = [];
    await walkDirectories(this.rootDir, '', folders);
    return folders;
  }

  /** 只列 .md 路径，不读内容——供同步引擎做路径集合差量。 */
  listMarkdownPaths() {
    return listMarkdownSync(this.rootDir);
  }

  directoryExists(relativePath) {
    try {
      return fsSync.statSync(this.resolveDirectory(relativePath)).isDirectory();
    } catch {
      return false;
    }
  }

  async read(relativePath) {
    const safePath = normalizeVaultRelativePath(relativePath);
    const raw = await fs.readFile(resolveVaultPath(this.rootDir, safePath), 'utf8');
    return parseMarkdownDocument(raw, safePath);
  }

  async write(note) {
    const relativePath = normalizeVaultRelativePath(note.filePath || `${note.title}.md`);
    const target = resolveVaultPath(this.rootDir, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, serializeMarkdownDocument({ ...note, filePath: relativePath }), 'utf8');
    await fs.rename(temporary, target);
    return { ...note, filePath: relativePath, hasFrontmatter: true };
  }

  async remove(relativePath) {
    const target = resolveVaultPath(this.rootDir, relativePath);
    await fs.rm(target, { force: true });
    if (!(await existsAsync(target))) return;
    await fs.unlink(target); // rm 静默失败时的兜底，见 removeSync 的注释
  }

  writeSync(note) {
    const relativePath = normalizeVaultRelativePath(note.filePath || `${note.title}.md`);
    const target = resolveVaultPath(this.rootDir, relativePath);
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      fsSync.writeFileSync(temporary, serializeMarkdownDocument({ ...note, filePath: relativePath }), 'utf8');
      fsSync.renameSync(temporary, target);
    } finally {
      if (fsSync.existsSync(temporary)) fsSync.rmSync(temporary, { force: true });
    }
    return { ...note, filePath: relativePath, hasFrontmatter: true };
  }

  existsSync(relativePath) {
    return fsSync.existsSync(resolveVaultPath(this.rootDir, relativePath));
  }

  readRawSync(relativePath) {
    const target = resolveVaultPath(this.rootDir, relativePath);
    try {
      return fsSync.readFileSync(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  writeRawSync(relativePath, content) {
    const safePath = normalizeVaultRelativePath(relativePath);
    const target = resolveVaultPath(this.rootDir, safePath);
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      fsSync.writeFileSync(temporary, content, 'utf8');
      fsSync.renameSync(temporary, target);
    } finally {
      if (fsSync.existsSync(temporary)) fsSync.rmSync(temporary, { force: true });
    }
  }

  removeSync(relativePath) {
    const target = resolveVaultPath(this.rootDir, relativePath);
    // Windows 实测：rmSync({force}) 对 ≥260 字符路径会静默失败，
    // 个别多字节长路径还会触发 libuv 原生 fast-fail（0xC0000409）使进程崩溃；
    // unlinkSync 能正确走 \\?\ 长路径前缀，因此首选 unlink，rmSync 仅作占用时兜底。
    try {
      fsSync.unlinkSync(target);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      fsSync.rmSync(target, { force: true });
    }
  }

  movePrefixSync(oldPrefix, newPrefix) {
    const prefix = oldPrefix ? `${oldPrefix}/` : '';
    const files = listMarkdownSync(this.rootDir);
    for (const relativePath of files) {
      if (!relativePath.startsWith(prefix)) continue;
      const suffix = relativePath.slice(prefix.length);
      const nextPath = newPrefix ? `${newPrefix}/${suffix}` : suffix;
      this.moveSync(relativePath, nextPath);
    }
  }

  relocatePrefixToRootSync(oldPrefix) {
    const prefix = `${oldPrefix}/`;
    const moves = [];
    for (const relativePath of listFilesSync(this.rootDir)) {
      if (!relativePath.startsWith(prefix)) continue;
      const source = resolveVaultPath(this.rootDir, relativePath, '');
      const isMarkdown = relativePath.toLowerCase().endsWith('.md');
      const document = isMarkdown ? parseMarkdownDocument(fsSync.readFileSync(source, 'utf8'), relativePath) : null;
      const targetName = document ? `${sanitizeFilePart(document.title)}.md` : path.posix.basename(relativePath);
      const targetPath = uniqueRootTarget(this.rootDir, targetName, moves.map((move) => move.toPath));
      this.moveSync(relativePath, targetPath);
      moves.push({ fromPath: relativePath, toPath: targetPath });
    }
    return moves;
  }

  moveDirectorySync(sourcePath, targetPath) {
    const source = this.resolveDirectory(sourcePath);
    const target = this.resolveDirectory(targetPath);
    if (!fsSync.existsSync(source)) {
      fsSync.mkdirSync(target, { recursive: true });
      return;
    }
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    fsSync.renameSync(source, target);
  }

  removeDirectorySync(relativePath) {
    const target = this.resolveDirectory(relativePath);
    fsSync.rmSync(target, { recursive: true, force: true });
    if (!fsSync.existsSync(target)) return;
    removeTreeFallback(target);
    if (fsSync.existsSync(target)) {
      // 删不掉要喊出来（目录被占用 / 权限被夺），静默残留会让上层误以为已删除
      throw new Error(`目录删除失败：${relativePath}`);
    }
  }

  moveSync(sourcePath, targetPath) {
    const source = resolveVaultPath(this.rootDir, sourcePath, '');
    const target = resolveVaultPath(this.rootDir, targetPath, '');
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    fsSync.renameSync(source, target);
  }

  resolveDirectory(relativePath) {
    const normalized = String(relativePath ?? '').trim().replaceAll('\\', '/');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
      throw new Error('Vault directory path must be relative');
    }
    const parts = normalized.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\u0000]/.test(part))) {
      throw new Error('Invalid Vault directory path');
    }
    const target = path.resolve(this.rootDir, ...parts);
    const relative = path.relative(this.rootDir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Vault path escapes root');
    return target;
  }
}

async function walk(root, relativeDir, result) {
  const absoluteDir = path.join(root, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === INTERNAL_DIR || entry.name.startsWith('.')) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, relativePath, result);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      result.push(relativePath);
    }
  }
}

async function walkDirectories(root, relativeDir, result) {
  const absoluteDir = path.join(root, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === INTERNAL_DIR || entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    result.push(relativePath);
    await walkDirectories(root, relativePath, result);
  }
}

function listMarkdownSync(root, relativeDir = '', result = []) {
  const absoluteDir = path.join(root, relativeDir);
  for (const entry of fsSync.readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.name === INTERNAL_DIR || entry.name.startsWith('.')) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listMarkdownSync(root, relativePath, result);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) result.push(relativePath);
  }
  return result;
}

function listFilesSync(root, relativeDir = '', result = []) {
  const absoluteDir = path.join(root, relativeDir);
  for (const entry of fsSync.readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.name === INTERNAL_DIR || entry.name.startsWith('.')) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listFilesSync(root, relativePath, result);
    else if (entry.isFile()) result.push(relativePath);
  }
  return result;
}

async function existsAsync(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function removeTreeFallback(target) {
  // rmSync 在部分 Windows 环境（杀软 / 沙箱）会静默失败：后序遍历，
  // 先 unlink 文件再 rmdir 空目录——这两条系统调用走的是不同路径，通常能成功。
  for (const entry of fsSync.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) removeTreeFallback(child);
    else fsSync.unlinkSync(child);
  }
  fsSync.rmdirSync(target);
}

function uniqueRootTarget(root, name, reservedPaths) {  const extension = path.posix.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  let candidate = name;
  let counter = 2;
  while (fsSync.existsSync(resolveVaultPath(root, candidate)) || reservedPaths.includes(candidate)) {
    candidate = `${stem} (${counter})${extension}`;
    counter += 1;
  }
  return candidate;
}
