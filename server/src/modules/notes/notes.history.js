import fs from 'node:fs';
import path from 'node:path';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { config } from '../../config/index.js';
import { hashRaw, serializeMarkdownDocument } from '../../vault/markdown.js';
import { resolveVaultPath } from '../../vault/path.js';
import { VaultAdapter } from '../../vault/vault.adapter.js';

const HISTORY_ROOT = '.lattice/history';
const VERSION_PATTERN = /^(\d{8}T\d{9}Z)-([a-f0-9]{64})$/;
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// 单篇笔记的历史快照上限：自动保存会高频触发快照，不设上限磁盘会被写爆。
// 超出后从最旧开始删除；内容与最新快照相同的直接跳过不写。
const MAX_SNAPSHOTS_PER_NOTE = 200;

const vault = new VaultAdapter(config.vaultDir);

/**
 * History is deliberately a filesystem projection. The original Markdown bytes
 * are retained so restoring a version does not lose formatting or frontmatter
 * that the current SQLite projection does not model.
 */
export function createSnapshot(note, rawOverride = null) {
  assertNoteId(note.id);
  const raw = rawOverride ?? readCurrentRaw(note);
  const hash = hashRaw(raw);

  const existing = listSnapshots(note.id);
  // 内容与最新快照一致时不重复写：编辑器自动保存会以相同内容反复触发保存
  if (existing.length && existing[0].hash === hash) {
    return { version: existing[0].version, hash, createdAt: existing[0].createdAt, size: existing[0].size, skipped: true };
  }

  const directory = historyDirectory(note.id);
  fs.mkdirSync(directory, { recursive: true });

  let timestamp = Date.now();
  let version = formatVersion(timestamp, hash);
  while (fs.existsSync(versionPath(note.id, version))) {
    timestamp += 1;
    version = formatVersion(timestamp, hash);
  }

  vault.writeRawSync(`${HISTORY_ROOT}/${note.id}/${version}.md`, raw);
  pruneSnapshots(note.id);
  return {
    version,
    hash,
    createdAt: versionCreatedAt(version),
    size: Buffer.byteLength(raw, 'utf8'),
  };
}

/** 快照数量超出上限时从最旧开始删除（按版本名排序，时间戳前缀保证字典序即时间序） */
function pruneSnapshots(noteId) {
  const snapshots = listSnapshots(noteId);
  for (const snapshot of snapshots.slice(MAX_SNAPSHOTS_PER_NOTE)) {
    try {
      fs.rmSync(versionPath(noteId, snapshot.version), { force: true });
    } catch {
      // 单个快照删除失败不阻断保存流程，下次写入会再尝试
    }
  }
}

export function listSnapshots(noteId) {
  assertNoteId(noteId);
  const directory = historyDirectory(noteId);
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name.slice(0, -3))
    .filter((version) => VERSION_PATTERN.test(version))
    .map((version) => {
      const match = VERSION_PATTERN.exec(version);
      const file = versionPath(noteId, version);
      return {
        version,
        hash: match[2],
        createdAt: versionCreatedAt(version),
        size: fs.statSync(file).size,
      };
    })
    .sort((left, right) => right.version.localeCompare(left.version));
}

export function readSnapshot(noteId, version) {
  assertNoteId(noteId);
  assertVersion(version);
  const raw = vault.readRawSync(`${HISTORY_ROOT}/${noteId}/${version}.md`);
  if (raw === null) throw new NotFoundError('历史版本不存在');

  const match = VERSION_PATTERN.exec(version);
  return {
    version,
    raw,
    hash: hashRaw(raw),
    createdAt: versionCreatedAt(version),
    expectedHash: match[2],
  };
}

export function currentRaw(note) {
  return readCurrentRaw(note);
}

export function currentHash(note) {
  return hashRaw(readCurrentRaw(note));
}

function readCurrentRaw(note) {
  const raw = note.filePath ? vault.readRawSync(note.filePath) : null;
  if (raw !== null) return raw;
  return serializeMarkdownDocument(note);
}

function historyDirectory(noteId) {
  assertNoteId(noteId);
  return path.join(vault.rootDir, HISTORY_ROOT, noteId);
}

function versionPath(noteId, version) {
  assertNoteId(noteId);
  assertVersion(version);
  return resolveVaultPath(vault.rootDir, `${HISTORY_ROOT}/${noteId}/${version}.md`, '');
}

function assertNoteId(noteId) {
  if (!NOTE_ID_PATTERN.test(String(noteId ?? ''))) {
    throw new ValidationError('Invalid note id');
  }
}

function assertVersion(version) {
  if (!VERSION_PATTERN.test(String(version ?? ''))) {
    throw new ValidationError('历史版本标识无效');
  }
}

function formatVersion(timestamp, hash) {
  const date = new Date(timestamp);
  const stamp = [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
    'T',
    date.getUTCHours().toString().padStart(2, '0'),
    date.getUTCMinutes().toString().padStart(2, '0'),
    date.getUTCSeconds().toString().padStart(2, '0'),
    date.getUTCMilliseconds().toString().padStart(3, '0'),
    'Z',
  ].join('');
  return `${stamp}-${hash}`;
}

function versionCreatedAt(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return null;
  const stamp = match[1];
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
  return new Date(iso).toISOString();
}

export function assertSnapshotMatchesHash(snapshot) {
  if (snapshot.hash !== snapshot.expectedHash) {
    throw new ConflictError('历史版本文件已损坏，无法恢复');
  }
}
