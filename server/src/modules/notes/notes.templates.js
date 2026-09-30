import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import * as foldersRepository from '../folders/folders.repository.js';
import * as foldersService from '../folders/folders.service.js';
import * as notesRepository from './notes.repository.js';
import * as notesService from './notes.service.js';
import { applyVaultChange } from '../../vault/sync.js';
import { parseMarkdownDocument } from '../../vault/markdown.js';
import { resolveVaultPath } from '../../vault/path.js';
import { VaultAdapter } from '../../vault/vault.adapter.js';

const TEMPLATE_DIR = '_templates';
const DAILY_FOLDER = 'Daily';
const TEMPLATE_FILE_PATTERN = /^[^/\\<>:"|?*\u0000-\u001f]+\.md$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const vault = new VaultAdapter(config.vaultDir);

export function listTemplates() {
  const directory = templateDirectory();
  fs.mkdirSync(directory, { recursive: true });

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && TEMPLATE_FILE_PATTERN.test(entry.name))
    .map((entry) => {
      const name = entry.name.slice(0, -3);
      const filePath = `${TEMPLATE_DIR}/${entry.name}`;
      const raw = fs.readFileSync(path.join(directory, entry.name), 'utf8');
      const parsed = parseMarkdownDocument(raw, filePath);
      return {
        name,
        filePath,
        title: parsed.title,
        size: Buffer.byteLength(raw, 'utf8'),
        updatedAt: fs.statSync(path.join(directory, entry.name)).mtime.toISOString(),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

export function createFromTemplate({ template, title, date, folderId = null }) {
  const raw = readTemplate(template);
  const initial = parseMarkdownDocument(raw, `${TEMPLATE_DIR}/${templateFileName(template)}`);
  const resolvedDate = normalizeDate(date);
  const resolvedTitle = title?.trim() || initial.title;
  const rendered = renderTemplate(raw, {
    date: resolvedDate,
    time: formatLocalTime(new Date()),
    title: resolvedTitle,
  });
  const parsed = parseMarkdownDocument(rendered, `${TEMPLATE_DIR}/${templateFileName(template)}`);

  return notesService.create({
    title: title?.trim() || parsed.title,
    content: parsed.content,
    folderId,
    properties: parsed.properties,
  });
}

export async function createDaily({ date } = {}) {
  const resolvedDate = normalizeDate(date);
  const folder = ensureDailyFolder();
  const filePath = `${DAILY_FOLDER}/${resolvedDate}.md`;
  const existing = notesRepository.findByFilePath(filePath);
  if (existing) return notesService.getDetail(existing.id);

  // Recover a manually created daily file into the projection before deciding
  // whether a second file would be created. Only this one file needs to be
  // reconciled; a full-vault scan would block the event loop for seconds.
  if (vault.existsSync(filePath)) {
    await applyVaultChange(vault, filePath);
    const recovered = notesRepository.findByFilePath(filePath);
    if (recovered) return notesService.getDetail(recovered.id);
    throw new ConflictError('每日笔记文件已存在但无法建立投影');
  }

  const template = templateExists('daily')
    ? createFromTemplate({ template: 'daily', title: resolvedDate, date: resolvedDate, folderId: folder.id })
    : notesService.create({
      title: resolvedDate,
      content: `# ${resolvedDate}\n\n`,
      folderId: folder.id,
    });

  return template;
}

function readTemplate(template) {
  const fileName = templateFileName(template);
  const file = resolveVaultPath(config.vaultDir, `${TEMPLATE_DIR}/${fileName}`, '');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new NotFoundError('Template not found');
    throw error;
  }
}

function templateExists(template) {
  try {
    return fs.existsSync(resolveVaultPath(config.vaultDir, `${TEMPLATE_DIR}/${templateFileName(template)}`, ''));
  } catch {
    return false;
  }
}

function templateFileName(template) {
  const value = String(template ?? '').trim();
  const fileName = value.toLowerCase().endsWith('.md') ? value : `${value}.md`;
  if (!TEMPLATE_FILE_PATTERN.test(fileName) || fileName.includes('..')) {
    throw new ValidationError('Invalid template name');
  }
  return fileName;
}

function templateDirectory() {
  return path.join(config.vaultDir, TEMPLATE_DIR);
}

function renderTemplate(raw, values) {
  return raw.replace(/\{\{\s*(date|time|title)\s*\}\}/gi, (_match, key) => values[key.toLowerCase()] ?? '');
}

function normalizeDate(value) {
  const date = value ?? localDate(new Date());
  if (!DATE_PATTERN.test(date)) throw new ValidationError('Date must use YYYY-MM-DD format');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new ValidationError('Date is not a valid calendar date');
  }
  return date;
}

function ensureDailyFolder() {
  return foldersRepository.findByNameAndParent(DAILY_FOLDER, null) ?? foldersService.create({ name: DAILY_FOLDER });
}

function localDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatLocalTime(date) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
