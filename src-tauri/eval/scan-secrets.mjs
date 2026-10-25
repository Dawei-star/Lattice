#!/usr/bin/env node
/**
 * 密钥字面量扫描（W9 地基 ⑧，CI 红线，地基方案 §11.1）：
 * 源码、示例、测试、夹具、文档中不出现任何可用凭据字面量；
 * 密钥只允许以 env 引用（LATTICE_PROVIDER__<ID>__API_KEY）、密钥服务或掩码形态出现。
 *
 * 判定原则：只报「可用凭据」——已知厂商前缀（sk-…、AIza、ghp_、xoxb、AKIA、JWT）或
 * 凭据型键名（apiKey/secret/token/password…）赋了长字面量。占位与打码形态
 * （masked:*、demo-*、${env}、<占位>、星号串、marker/fake 等）不算可用凭据。
 * 测试需要凭据形态的样本时用运行时拼接构造（如 `'sk-' + 'a'.repeat(32)`），
 * 不要把完整字面量写进源码。个别确需保留的行可加行内标记 `lattice:allow-secret`。
 *
 * 扫描范围 = git 视角的工作区（已跟踪 + 未跟踪但未被 ignore 的文本文件）；
 * git 不可用时退化为按 .gitignore 同款目录黑名单递归走盘。
 *
 * 用法：node src-tauri/eval/scan-secrets.mjs [repoRoot]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ALLOW_MARKER = 'lattice:allow-secret';

/** 凭据规则。带捕获组的取捕获组作为凭据值，否则取整段匹配。 */
export const SECRET_RULES = [
  { name: 'sk-style-key', re: /(?<![A-Za-z0-9])sk-(?:proj-|svcacct-)?[A-Za-z0-9][A-Za-z0-9_-]{19,}/g, group: 0 },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g, group: 0 },
  { name: 'github-token', re: /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, group: 0 },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, group: 0 },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g, group: 0 },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, group: 0 },
  {
    name: 'credential-assignment',
    re: /\b(api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|passwd|password|pwd)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi,
    group: 2,
  },
  { name: 'bearer-literal', re: /\bbearer\s+([a-z0-9][a-z0-9._~+/=-]{19,})/gi, group: 1 },
];

/**
 * 占位/打码判定：命中任一即不算可用凭据。
 * 真实厂商密钥是随机串，不会包含这些词；这不是漏洞豁免通道，
 * 而是让「故意写出来的假样本」不用拼接也能与真密钥区分。
 */
export function isPlaceholderValue(value) {
  const s = String(value ?? '').trim();
  if (s.length < 8) return true;
  if (/[<>{}[\]$%]/.test(s)) return true; // 模板与占位语法：${env}、<your-key>、{{var}}
  if (/^[xX*•_.-]{6,}$/.test(s)) return true; // 打码串：sk-***、xxxxxx、...
  if (/(masked|redacted|not[-_]?a[-_]?secret|not[-_]?set|unset|placeholder|example|sample|dummy|fake|demo|marker|changeme|change[-_]me|workspace|fixture|mock|test|xxx|your|insert|paste|replace|todo|temporary|secret)/i.test(s)) {
    return true;
  }
  return false;
}

function redact(value) {
  const s = String(value);
  return s.length <= 6 ? `${s.slice(0, 2)}***` : `${s.slice(0, 6)}***<len ${s.length}>`;
}

/** 扫描一段文本，返回命中列表（file 字段由调用方补）。 */
export function scanText(text) {
  const hits = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
    if (line.includes(ALLOW_MARKER)) continue;
    for (const rule of SECRET_RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags);
      let match;
      while ((match = re.exec(line)) !== null) {
        if (match.index === re.lastIndex) re.lastIndex += 1; // 防御零宽匹配死循环
        const value = match[rule.group] ?? match[0];
        if (isPlaceholderValue(value)) continue;
        hits.push({ rule: rule.name, line: lineNo + 1, preview: redact(value) });
      }
    }
  }
  return hits;
}

/** 扫描单个文件，返回带 file 路径的命中列表。 */
export function scanFile(filePath) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return []; // 已从工作区删除但仍在 git 索引中的路径
  }
  if (stat.size > MAX_FILE_BYTES) return [];
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  if (text.includes('\0')) return []; // 二进制文件
  return scanText(text).map((hit) => ({ file: filePath, ...hit }));
}

const TEXT_EXTENSIONS = new Set([
  'rs', 'ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'md', 'markdown', 'toml', 'yml', 'yaml',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'txt', 'ps1', 'sh', 'bat', 'cmd', 'py', 'sql',
  'ini', 'cfg', 'conf', 'lock',
]);
const SKIP_DIR_NAMES = new Set([
  '.git', 'node_modules', 'target', 'dist', 'build', '.build', 'gen', '.agents', '.mimosa',
  '.playwright-cli', '.verify-tmp', '.workbuddy', '.tmp-asar', '.zcode', 'output', 'tmp_report',
  'downloads', 'packaging', 'promo-video', 'docs', 'desktop', '.idea', '.vscode', 'coverage',
]);

function isScannableFile(filePath) {
  const base = filePath.split(/[\\/]/).pop();
  if (base.startsWith('.env')) return false; // 本地环境文件永不入库，也不扫描（内含真实密钥属正常）
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return TEXT_EXTENSIONS.has(ext) || dot === -1; // 无扩展名的 LICENSE/FILES 等也扫
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) visit(full);
      } else if (entry.isFile() && isScannableFile(full)) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

/** 文件清单优先 git 视角（tracked + 未 ignore 的 untracked），退化走盘。 */
export function listRepoFiles(root) {
  try {
    const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8');
    const files = out.split('\0').filter(Boolean)
      .map((rel) => resolve(root, rel))
      .filter(isScannableFile);
    if (files.length) return files;
  } catch {
    // 无 git（罕见）时退化
  }
  return walkFiles(root);
}

export function scanRepo(root) {
  const files = listRepoFiles(root);
  const hits = [];
  for (const file of files) {
    hits.push(...scanFile(file));
  }
  return { root, filesScanned: files.length, hits };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '..', '..');
  const result = scanRepo(root);
  if (result.hits.length) {
    console.error(`密钥字面量扫描：${result.hits.length} 处命中（${result.filesScanned} 个文件）`);
    for (const hit of result.hits) {
      const rel = relative(result.root, hit.file).split(sep).join('/');
      console.error(`  [${hit.rule}] ${rel}:${hit.line} → ${hit.preview}`);
    }
    console.error('处理：真实凭据一律改走 env（LATTICE_PROVIDER__<ID>__API_KEY）；确需保留的示例行加行内标记 lattice:allow-secret。');
    process.exitCode = 1;
  } else {
    console.log(`密钥字面量扫描通过：${result.filesScanned} 个文件，0 命中`);
  }
}
