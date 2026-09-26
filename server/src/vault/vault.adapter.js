import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeVaultRelativePath, resolveVaultPath } from './path.js';
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
    await fs.rm(resolveVaultPath(this.rootDir, relativePath), { force: true });
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

  removeSync(relativePath) {
    fsSync.rmSync(resolveVaultPath(this.rootDir, relativePath), { force: true });
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
    for (const relativePath of listMarkdownSync(this.rootDir)) {
      if (!relativePath.startsWith(prefix)) continue;
      const source = resolveVaultPath(this.rootDir, relativePath);
      const document = parseMarkdownDocument(fsSync.readFileSync(source, 'utf8'), relativePath);
      let targetName = safeFileName(document.title);
      let targetPath = `${targetName}.md`;
      let counter = 2;
      while (fsSync.existsSync(resolveVaultPath(this.rootDir, targetPath))) {
        targetPath = `${targetName} (${counter})-${document.id.slice(0, 8)}.md`;
        counter += 1;
      }
      this.moveSync(relativePath, targetPath);
    }
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
    fsSync.rmSync(this.resolveDirectory(relativePath), { recursive: true, force: true });
  }

  moveSync(sourcePath, targetPath) {
    const source = resolveVaultPath(this.rootDir, sourcePath);
    const target = resolveVaultPath(this.rootDir, targetPath);
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

function safeFileName(value) {
  return String(value || '未命名笔记')
    .replace(/[<>:"/\\|?*\u0000]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || '未命名笔记';
}
