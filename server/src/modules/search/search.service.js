/**
 * 搜索服务层。
 *
 * 两段式策略：
 *   - 查询长度 >= 3：优先走 FTS5（trigram 分词，可对中文做子串匹配），按 bm25 相关性排序
 *   - 查询长度 <  3：trigram 建不了索引，直接走 LIKE
 *   - FTS 命中为空：再用 LIKE 复核一次，避免分词边界导致的漏召回
 *
 * 返回的 excerpt 是纯文本，高亮交给前端完成，服务端不生成任何 HTML。
 */
import { toPlainText } from '../../lib/markdown.js';
import { config } from '../../config/index.js';
import { VaultAdapter } from '../../vault/vault.adapter.js';
import { parseMarkdownDocument } from '../../vault/markdown.js';
import * as repository from './search.repository.js';

const MIN_TRIGRAM_LENGTH = 3;
const vault = new VaultAdapter(config.vaultDir);

/** 转义 LIKE 通配符，避免用户输入的 % 变成「匹配一切」 */
function toLikePattern(query) {
  const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

/** FTS5 短语查询：整体加引号并按 FTS5 规则转义内部引号 */
function toFtsPhrase(query) {
  return `"${query.replace(/"/g, '""')}"`;
}

/** 截取命中位置附近的上下文片段 */
function buildExcerpt(content, query, radius = 60) {
  const plain = toPlainText(content);
  const index = plain.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return plain.slice(0, 120);

  const start = Math.max(0, index - radius);
  const end = Math.min(plain.length, index + query.length + radius);

  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`;
}

/**
 * @param {string} query 已 trim 的检索词
 * @param {number} limit
 * @param {string | undefined} folderId
 */
export function search(query, limit, folderId, inboxStatus) {
  const searchLimit = inboxStatus === undefined ? limit : Math.min(200, Math.max(limit * 6, 100));
  const useFullText = [...query].length >= MIN_TRIGRAM_LENGTH;

  let rows = [];
  let strategy = 'like';

  if (useFullText) {
    rows = repository.searchFullText(toFtsPhrase(query), searchLimit, folderId);
    strategy = 'fts';
  }

  if (rows.length === 0) {
    rows = repository.searchLike(toLikePattern(query), searchLimit, folderId);
    strategy = strategy === 'fts' ? 'like-fallback' : 'like';
  }

  const items = rows
    .map((row) => {
      const item = repository.mapRow(row, buildExcerpt(row.content, query));
      if (inboxStatus === undefined) return item;
      const raw = item.filePath ? vault.readRawSync(item.filePath) : null;
      const properties = raw === null ? {} : parseMarkdownDocument(raw, item.filePath).properties ?? {};
      return { ...item, properties };
    })
    .filter((item) => inboxStatus === undefined
      || (item.properties?.type === 'inbox'
        && (inboxStatus === 'all' || item.properties?.status === inboxStatus)))
    .slice(0, limit);

  return { strategy, items };
}
