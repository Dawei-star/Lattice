/**
 * 附件服务层：把 base64 内容落盘到 ATTACHMENTS_DIR，并在 attachments 表登记。
 *
 * 安全边界：
 *   - 落盘文件名由服务端用 UUID + 白名单扩展名生成，绝不用用户提供的名字，杜绝路径穿越。
 *   - 只接受常见「位图图片 + PDF」，刻意排除 SVG —— 同源直开一个含脚本的 SVG 就是一条 XSS 路径。
 *   - 解码后按 MAX_UPLOAD_MB 复核真实字节数，不信任前端声明的体积。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { BadRequestError, ValidationError } from '../../lib/errors.js';
import { nowIso } from '../../lib/time.js';
import * as notesRepository from '../notes/notes.repository.js';
import * as repository from './attachments.repository.js';

/** MIME → 落盘扩展名。不在表内的类型一律拒绝。 */
const ALLOWED_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

/** 保证目录存在；启动时也会调用一次，这里兜底并发/首次运行。 */
export function ensureDir() {
  fs.mkdirSync(config.attachmentsDir, { recursive: true });
}

/** 把存储文件名转成对外 URL 路径（同源，走 express.static 托管） */
function toUrl(storedName) {
  return `/attachments/${storedName}`;
}

/**
 * 上传一个附件。
 * @param {{ name?: string, mime: string, data: string }} input data 为纯 base64 字符串
 */
export function upload({ name, mime, data: dataBase64 }) {
  if (!mime || !ALLOWED_TYPES[mime]) {
    throw new ValidationError('不支持的文件类型', [
      { in: 'body', field: 'mime', message: `仅支持：${Object.keys(ALLOWED_TYPES).join('、')}` },
    ]);
  }
  if (!dataBase64 || typeof dataBase64 !== 'string') {
    throw new ValidationError('缺少文件内容', [{ in: 'body', field: 'data', message: 'data 不能为空' }]);
  }

  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) {
    throw new BadRequestError('文件内容为空');
  }
  const maxBytes = config.maxUploadMb * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw new ValidationError('文件超出体积上限', [
      { in: 'body', field: 'data', message: `单个附件最大 ${config.maxUploadMb} MB` },
    ]);
  }

  ensureDir();

  const storedName = `${randomUUID()}.${ALLOWED_TYPES[mime]}`;
  const target = path.join(config.attachmentsDir, storedName);
  // 文件名含随机 UUID，正常情况下不会撞车；写入即原子（同目录临时文件 + rename）
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, target);

  const timestamp = nowIso();
  const origName = (name ?? storedName).trim().slice(0, 255) || storedName;
  const record = repository.insert({
    id: randomUUID(),
    storedName,
    origName,
    mime,
    size: buffer.length,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    id: record.id,
    name: record.origName,
    mime: record.mime,
    size: record.size,
    url: toUrl(record.storedName),
    createdAt: record.createdAt,
  };
}

/**
 * 扫描所有笔记正文，算出每个 stored_name 被哪些笔记引用。
 * 附件引用是「正文派生数据」，与链接/标签同理——不建引用表，按正文实时计算，
 * 避免删除笔记时漏清台账导致计数漂移。
 * @returns {Map<string, Array<{ id: string, title: string }>>}
 */
function scanReferences() {
  /** @type {Map<string, Array<{ id: string, title: string }>>} */
  const refs = new Map();
  for (const note of notesRepository.listContents()) {
    const content = note.content ?? '';
    // 命中形如 /attachments/<uuid>.<ext> 的引用
    const pattern = /\/attachments\/([0-9a-fA-F-]{36}\.[a-z0-9]+)/g;
    for (const match of content.matchAll(pattern)) {
      const stored = match[1];
      if (!refs.has(stored)) refs.set(stored, []);
      // 同一篇笔记多次引用同一附件只算一个引用者
      if (!refs.get(stored).some((r) => r.id === note.id)) {
        refs.get(stored).push({ id: note.id, title: note.title });
      }
    }
  }
  return refs;
}

/** 列出全部附件，附带「被引用数」与引用它的笔记（不含落盘绝对路径，只给对外 URL） */
export function list() {
  const refs = scanReferences();
  return repository.listAll().map((row) => {
    const referrers = refs.get(row.storedName) ?? [];
    return {
      id: row.id,
      name: row.origName,
      mime: row.mime,
      size: row.size,
      url: toUrl(row.storedName),
      createdAt: row.createdAt,
      refCount: referrers.length,
      referrers,
    };
  });
}

/**
 * 清理孤儿附件：删除未被任何笔记引用的附件（台账 + 磁盘文件）。
 * @returns {{ removed: Array<{ id: string, name: string }> }}
 */
export function cleanupOrphans() {
  const refs = scanReferences();
  const removed = [];
  for (const row of repository.listAll()) {
    if ((refs.get(row.storedName) ?? []).length === 0) {
      remove(row.id);
      removed.push({ id: row.id, name: row.origName });
    }
  }
  return { removed };
}

/**
 * 删除附件：移除台账行 + 磁盘文件。
 * 刻意做成幂等——记录已不存在时返回 deleted=false，与笔记删除的语义一致。
 */
export function remove(id) {
  const record = repository.findById(id);
  if (!record) return { id, deleted: false };

  repository.remove(id);

  // 先删台账再删文件：即使文件删除失败，也不会残留「指向不存在文件」的行
  const target = path.join(config.attachmentsDir, record.storedName);
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // 文件可能已被手动删除；台账已清理，这里不再回滚
  }

  return { id, deleted: true };
}
