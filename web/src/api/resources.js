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

  /**
   * @param {string} id
   * @param {{ title?: string, content?: string, folderId?: string | null, isPinned?: boolean }} patch
   * @returns {Promise<NoteDetail>}
   */
  update: (id, patch, options = {}) => http.patch(`/notes/${id}`, patch, options),

  /** @returns {Promise<{ id: string, deleted: boolean }>} */
  remove: (id, options = {}) => http.delete(`/notes/${id}`, options),
};

export const versionsApi = {
  /**
   * @typedef {Object} VersionSummary
   * @property {string} id
   * @property {string} noteId
   * @property {string} title
   * @property {number} wordCount
   * @property {number} size 正文字符长度（列表不含正文）
   * @property {string} createdAt
   *
   * @typedef {Object} Version VersionSummary 的超集，额外含 content
   */
  /** @returns {Promise<VersionSummary[]>} */
  list: (noteId, options = {}) => http.get(`/notes/${noteId}/versions`, options),

  /** @returns {Promise<VersionSummary & { content: string }>} */
  get: (noteId, versionId, options = {}) => http.get(`/notes/${noteId}/versions/${versionId}`, options),

  /**
   * 恢复某条历史为当前内容。非幂等（每次会快照旧态），关闭重试。
   * @returns {Promise<{ note: NoteDetail, restoredFrom: string, noop: boolean }>}
   */
  restore: (noteId, versionId, options = {}) =>
    http.postFull(`/notes/${noteId}/versions/${versionId}/restore`, {}, { retries: 0, ...options }),
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

/** 把浏览器 File 读成纯 base64（去掉 data URL 前缀） */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export const attachmentsApi = {
  /**
   * 上传一个附件，返回可直接写进正文的同源 URL。
   * 上传非幂等（同一文件两次会得到两个存储名），因此关闭自动重试并放宽超时。
   * @param {File} file
   * @returns {Promise<{ id: string, name: string, mime: string, size: number, url: string, createdAt: string }>}
   */
  async upload(file, options = {}) {
    const data = await fileToBase64(file);
    return http.post(
      '/attachments',
      { name: file.name, mime: file.type, data },
      { retries: 0, timeout: 60_000, ...options },
    );
  },

  /**
   * @returns {Promise<Array<{ id: string, name: string, mime: string, size: number, url: string, createdAt: string, refCount: number, referrers: Array<{ id: string, title: string }> }>>}
   */
  list: (options = {}) => http.get('/attachments', options),

  /** 清理未被任何笔记引用的附件 @returns {Promise<{ removed: Array<{ id: string, name: string }> }>} */
  cleanup: (options = {}) => http.postFull('/attachments/cleanup', {}, { retries: 0, ...options }).then((p) => p?.data),

  /** @returns {Promise<{ id: string, deleted: boolean }>} */
  remove: (id, options = {}) => http.delete(`/attachments/${id}`, options),
};

export const searchApi = {
  /**
   * @param {string} q
   * @param {{ limit?: number }} [options]
   * @returns {Promise<{ items: Array<{ id: string, title: string, excerpt: string, folderId: string | null, updatedAt: string }>, strategy: string }>}
   */
  async query(q, options = {}) {
    const payload = await http.getFull('/search', { query: { q, limit: options.limit } });
    return { items: payload?.data ?? [], strategy: payload?.meta?.strategy ?? 'unknown' };
  },
};

export const graphApi = {
  /** @returns {Promise<{ nodes: Array<{ id: string, title: string, folderId: string | null, degree: number, wordCount: number }>, edges: Array<{ source: string, target: string }>, dangling: Array<{ targetTitle: string, referenceCount: number }>, stats: { nodeCount: number, edgeCount: number, isolatedCount: number } }>} */
  get: (options = {}) => http.get('/graph', options),
};

export const exportsApi = {
  /**
   * 导出整个知识库为自包含静态站点（落盘到服务端 EXPORT_DIR），返回预览入口。
   * 非幂等（每次生成新目录），关闭重试；全量渲染可能偏慢，放宽超时。
   * @returns {Promise<{ dir: string, run: string, entry: string, noteCount: number, attachmentCount: number, generatedAt: string }>}
   */
  staticSite: (options = {}) =>
    http.post('/export/static', {}, { retries: 0, timeout: 120_000, ...options }),
};

export const metaApi = {
  /** @returns {Promise<{ noteCount: number, folderCount: number, tagCount: number, linkCount: number, danglingCount: number, totalWords: number, danglingLinks: Array<{ targetTitle: string, referenceCount: number }> }>} */
  overview: (options = {}) => http.get('/meta/overview', options),
};

export const healthApi = {
  /** 探针不在 /api 之下，因此用 base: '' 走根路径 */
  probe: (options = {}) => http.get('/health', { base: '', timeout: 4000, retries: 0, ...options }),
};
