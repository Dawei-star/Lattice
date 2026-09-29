'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const MAX_MARKDOWN_SIZE = 2 * 1024 * 1024;

function normalizeCandidate(value) {
  let candidate = String(value ?? '').trim();
  if (candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"')) {
    candidate = candidate.slice(1, -1);
  }
  if (candidate.toLowerCase().startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }
  return candidate ? path.resolve(path.normalize(candidate)) : null;
}

function isMarkdownFile(filePath) {
  if (!filePath || path.extname(filePath).toLowerCase() !== '.md') return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findMarkdownFileArg(argv = []) {
  for (const value of [...argv].reverse()) {
    if (typeof value !== 'string' || value.startsWith('-')) continue;
    const candidate = normalizeCandidate(value);
    if (isMarkdownFile(candidate)) return candidate;
  }
  return null;
}

function resolveExternalMarkdown(filePath) {
  const target = normalizeCandidate(filePath);
  if (!isMarkdownFile(target)) {
    throw new Error('只能打开真实存在的 Markdown 文件');
  }
  return target;
}

function readExternalMarkdown(filePath) {
  const target = resolveExternalMarkdown(filePath);
  const stats = fs.statSync(target);
  if (stats.size > MAX_MARKDOWN_SIZE) {
    throw new Error('Markdown 文件不能超过 2 MB');
  }
  return fs.readFileSync(target, 'utf8');
}

function writeExternalMarkdown(filePath, content, { authorized = false } = {}) {
  if (!authorized) throw new Error('请先获取外部文件写权限');
  const target = resolveExternalMarkdown(filePath);
  if (typeof content !== 'string' || content.length > MAX_MARKDOWN_SIZE) {
    throw new Error('Markdown 文件内容不能超过 2 MB');
  }

  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, target);
    return true;
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

module.exports = {
  MAX_MARKDOWN_SIZE,
  findMarkdownFileArg,
  resolveExternalMarkdown,
  readExternalMarkdown,
  writeExternalMarkdown,
};
