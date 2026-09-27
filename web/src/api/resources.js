/**
 * 后端资源的类型化访问层。
 * 所有接口路径集中在这里，组件不直接拼 URL；JSDoc 提供跨端类型提示。
 *
 * 对应后端契约（详见 server/src/routes/index.js）：
 *   GET    /api/notes            列表（分页/过滤/排序）
 *   GET    /api/notes/index      全量轻量索引
 *   GET    /api/notes/:id        详情（含标签、出链、反链）
 *   POST   /api/notes            新建（可带客户端 UUID，幂等）
 *   PATCH  /api/notes/:id        局部更新
 *   DELETE /api/notes/:id        删除（幂等）
 */
import { http } from './client.js';

/**
 * @typedef {Object} Tag
 * @property {string} id
 * @property {string} name
 * @property {number} noteCount
 *
 * @typedef {Object} NoteSummary
 * @property {string} id
 * @property {string} title
 * @property {string | null} folderId
 * @property {boolean} isPinned
 * @property {number} wordCount
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} filePath
 * @property {string} excerpt
 * @property {Tag[]} tags
 * @property {number} outgoingCount
 * @property {number} backlinkCount
 *
 * @typedef {Object} NoteIndexEntry
 * @property {string} id
 * @property {string} title
 * @property {string | null} folderId
 * @property {boolean} isPinned
 * @property {number} wordCount
 * @property {string} updatedAt
 *
 * @typedef {Object} NoteDetail
 * @property {string} id
 * @property {string} title
 * @property {string} content
 * @property {string | null} folderId
 * @property {boolean} isPinned
 * @property {number} wordCount
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {Tag[]} tags
 * @property {Array<{ targetTitle: string, targetNoteId: string | null, resolvedTitle: string | null, resolved: boolean }>} outgoing
 * @property {Array<{ sourceNoteId: string, sourceTitle: string, sourceUpdatedAt: string }>} backlinks
 *
 * @typedef {Object} FolderNode
 * @property {string} id
 * @property {string} name
 * @property {string | null} parentId
 * @property {number} sortOrder
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {number} noteCount
 * @property {FolderNode[]} children
 */

export const notesApi = {
  /**
   * @param {{ folderId?: string, tagId?: string, sort?: 'updated'|'created'|'title', limit?: number, offset?: number }} [query]
   * @returns {Promise<{ items: NoteSummary[], total: number }>}
   */
  async list(query = {}, options = {}) {
    const payload = await http.getFull('/notes', { query, ...options });
    return { items: payload?.data ?? [], total: payload?.meta?.total ?? 0 };
  },

  /** @returns {Promise<NoteIndexEntry[]>} */
  index: (options = {}) => http.get('/notes/index', options),

  /** @returns {Promise<NoteDetail>} */
  get: (id, options = {}) => http.get(`/notes/${id}`, options),

  /**
   * 新建笔记。客户端生成 id，使请求在超时重试时保持幂等。
   * @returns {Promise<NoteDetail>}
   */
  create: (input = {}, options = {}) =>
    http.post('/notes', {
      id: input.id ?? crypto.randomUUID(),
      title: input.title,
      content: input.content ?? '',
      folderId: input.folderId ?? null,
    }, options),

  duplicate: (id, input = {}, options = {}) => http.post(`/notes/${id}/duplicate`, input, options),

  /**
   * @param {string} id
   * @param {{ title?: string, content?: string, folderId?: string | null, isPinned?: boolean }} patch
   * @returns {Promise<NoteDetail>}
   */
  update: (id, patch, options = {}) => http.patch(`/notes/${id}`, patch, options),

  /** @returns {Promise<{ id: string, deleted: boolean }>} */
  remove: (id, options = {}) => http.delete(`/notes/${id}`, options),
};

export const foldersApi = {
  /** @returns {Promise<FolderNode[]>} */
  list: (options = {}) => http.get('/folders', options),
  create: (input, options = {}) => http.post('/folders', input, options),
  update: (id, patch, options = {}) => http.patch(`/folders/${id}`, patch, options),
  remove: (id, options = {}) => http.delete(`/folders/${id}`, options),
};

export const tagsApi = {
  /** @returns {Promise<Tag[]>} */
  list: (options = {}) => http.get('/tags', options),
  remove: (id, options = {}) => http.delete(`/tags/${id}`, options),
};

export const searchApi = {
  /**
   * @param {string} q
   * @param {{ limit?: number }} [options]
   * @returns {Promise<{ items: Array<{ id: string, title: string, excerpt: string, folderId: string | null, updatedAt: string }>, strategy: string }>}
   */
  async query(q, options = {}) {
    const payload = await http.getFull('/search', { query: { q, limit: options.limit, folderId: options.folderId } });
    return { items: payload?.data ?? [], strategy: payload?.meta?.strategy ?? 'unknown' };
  },
};

export const graphApi = {
  /** @returns {Promise<{ nodes: Array<{ id: string, title: string, folderId: string | null, degree: number, wordCount: number }>, edges: Array<{ source: string, target: string }>, dangling: Array<{ targetTitle: string, referenceCount: number }>, stats: { nodeCount: number, edgeCount: number, isolatedCount: number } }>} */
  get: (options = {}) => http.get('/graph', options),
};

export const metaApi = {
  /** @returns {Promise<{ noteCount: number, folderCount: number, tagCount: number, linkCount: number, danglingCount: number, totalWords: number, danglingLinks: Array<{ targetTitle: string, referenceCount: number }> }>} */
  overview: (options = {}) => http.get('/meta/overview', options),
};

export const healthApi = {
  /** 探针不在 /api 之下，因此用 base: '' 走根路径 */
  probe: (options = {}) => http.get('/health', { base: '', timeout: 4000, retries: 0, ...options }),
};
