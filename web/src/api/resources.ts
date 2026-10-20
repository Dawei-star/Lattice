/**
 * 后端资源的类型化访问层。
 * 所有接口路径集中在这里，组件不直接拼 URL；类型定义提供跨端类型提示。
 *
 * 对应后端契约（详见 server/src/routes/index.js）：
 *   GET    /api/notes            列表（分页/过滤/排序）
 *   GET    /api/notes/index      全量轻量索引
 *   GET    /api/notes/:id        详情（含标签、出链、反链）
 *   POST   /api/notes            新建（可带客户端 UUID，幂等）
 *   PATCH  /api/notes/:id        局部更新
 *   DELETE /api/notes/:id        删除（幂等）
 */
import { http, type RequestOptions } from './client.ts';

/** 笔记属性值：字符串 / 数字 / 布尔 / null / 字符串数组。 */
export type NoteProperties = Record<string, string | number | boolean | null | string[]>;

/** 标签。 */
export interface Tag {
  id: string;
  name: string;
  noteCount: number;
}

/** 笔记列表项（列表 / 检索返回的轻量摘要）。 */
export interface NoteSummary {
  id: string;
  title: string;
  folderId: string | null;
  filePath: string;
  isPinned: boolean;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
  excerpt: string;
  properties: NoteProperties;
  tags: Tag[];
  outgoingCount: number;
  backlinkCount: number;
}

/** 全量轻量索引条目（GET /notes/index）。 */
export interface NoteIndexEntry {
  id: string;
  title: string;
  folderId: string | null;
  isPinned: boolean;
  wordCount: number;
  updatedAt: string;
  properties: NoteProperties;
}

/** 笔记出链（wiki 引用解析结果）。 */
export interface NoteOutgoingLink {
  targetTitle: string;
  targetNoteId: string | null;
  resolvedTitle: string | null;
  resolved: boolean;
}

/** 笔记反链。 */
export interface NoteBacklink {
  sourceNoteId: string;
  sourceTitle: string;
  sourceUpdatedAt: string;
}

/** 笔记详情（GET /notes/:id）。 */
export interface NoteDetail {
  id: string;
  title: string;
  content: string;
  folderId: string | null;
  isPinned: boolean;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
  outgoing: NoteOutgoingLink[];
  backlinks: NoteBacklink[];
}

/** 笔记历史版本列表项（GET /notes/:id/history）。 */
export interface NoteHistoryEntry {
  version: string;
  hash: string;
  createdAt?: string | null;
  size: number;
}

/** 笔记历史版本内容（GET /notes/:id/history/:version）。 */
export interface NoteHistoryVersion {
  version: string;
  hash: string;
  createdAt?: string | null;
  title: string;
  content: string;
  isPinned: boolean;
  properties: NoteProperties;
}

/** 文件夹树节点。 */
export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  noteCount: number;
  children: FolderNode[];
}

/** 笔记列表查询参数。 */
export interface NotesListQuery {
  folderId?: string;
  tagId?: string;
  inboxStatus?: 'all' | 'captured' | 'processing' | 'processed';
  sort?: 'updated' | 'created' | 'title';
  limit?: number;
  offset?: number;
  [key: string]: unknown;
}

/** 新建笔记载荷：id 由客户端生成，保证超时重试时请求幂等。 */
export interface NoteCreateInput {
  id?: string;
  title?: string;
  content?: string;
  folderId?: string | null;
  properties?: NoteProperties;
  confirmed?: boolean;
  secondConfirmed?: boolean;
}

/** 笔记局部更新载荷（PATCH /notes/:id）。 */
export interface NoteUpdatePatch {
  title?: string;
  content?: string;
  folderId?: string | null;
  isPinned?: boolean;
}

export const notesApi = {
  async list(query: NotesListQuery = {}, options: RequestOptions = {}): Promise<{ items: NoteSummary[]; total: number }> {
    const payload = await http.getFull<{ data?: NoteSummary[]; meta?: { total?: number } }>('/notes', { query, ...options });
    return { items: payload?.data ?? [], total: payload?.meta?.total ?? 0 };
  },

  index: (options: RequestOptions = {}): Promise<NoteIndexEntry[]> => http.get<NoteIndexEntry[]>('/notes/index', options),

  get: (id: string, options: RequestOptions = {}): Promise<NoteDetail> => http.get<NoteDetail>(`/notes/${id}`, options),

  /**
   * 新建笔记。客户端生成 id，使请求在超时重试时保持幂等。
   */
  create: (input: NoteCreateInput = {}, options: RequestOptions = {}): Promise<NoteDetail> =>
    http.post<NoteDetail>('/notes', {
      id: input.id ?? crypto.randomUUID(),
      title: input.title,
      content: input.content ?? '',
      folderId: input.folderId ?? null,
      properties: input.properties ?? {},
      confirmed: input.confirmed === true,
      secondConfirmed: input.secondConfirmed === true,
    }, options),

  // 非幂等接口：超时重试会在服务端产生重复副本，必须关闭自动重试
  duplicate: (id: string, input: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<unknown> => http.post(`/notes/${id}/duplicate`, input, { retries: 0, ...options }),

  update: (id: string, patch: NoteUpdatePatch, options: RequestOptions = {}): Promise<NoteDetail> => http.patch<NoteDetail>(`/notes/${id}`, patch, options),

  history: (id: string, options: RequestOptions = {}): Promise<{ items: NoteHistoryEntry[]; currentHash: string }> =>
    http.get<{ items: NoteHistoryEntry[]; currentHash: string }>(`/notes/${id}/history`, options),
  historyVersion: (id: string, version: string | number, options: RequestOptions = {}): Promise<NoteHistoryVersion> =>
    http.get<NoteHistoryVersion>(`/notes/${id}/history/${version}`, options),
  restoreHistory: (id: string, version: string | number, body: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<unknown> => http.post(`/notes/${id}/history/${version}/restore`, body, options),
  templates: (options: RequestOptions = {}): Promise<unknown[]> => http.get<unknown[]>('/notes/templates', options),
  createFromTemplate: (input: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<NoteDetail> => http.post<NoteDetail>('/notes/from-template', input, { retries: 0, ...options }),
  createDaily: (input: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<NoteDetail> => http.post<NoteDetail>('/notes/daily', input, { retries: 0, ...options }),

  remove: (id: string, options: RequestOptions = {}): Promise<{ id: string; deleted: boolean }> => http.delete<{ id: string; deleted: boolean }>(`/notes/${id}`, options),
};

export const foldersApi = {
  list: (options: RequestOptions = {}): Promise<FolderNode[]> => http.get<FolderNode[]>('/folders', options),
  // 非幂等接口：超时重试会创建重复文件夹，关闭自动重试
  create: (input: Record<string, unknown>, options: RequestOptions = {}): Promise<FolderNode> => http.post<FolderNode>('/folders', input, { retries: 0, ...options }),
  update: (id: string, patch: Record<string, unknown>, options: RequestOptions = {}): Promise<FolderNode> => http.patch<FolderNode>(`/folders/${id}`, patch, options),
  remove: (id: string, options: RequestOptions = {}): Promise<unknown> => http.delete(`/folders/${id}`, options),
};

export const tagsApi = {
  list: (options: RequestOptions = {}): Promise<Tag[]> => http.get<Tag[]>('/tags', options),
  remove: (id: string, options: RequestOptions = {}): Promise<unknown> => http.delete(`/tags/${id}`, options),
};

/** 检索命中项。 */
export interface SearchHit {
  id: string;
  title: string;
  excerpt: string;
  folderId: string | null;
  updatedAt: string;
}

/** 检索查询参数。 */
export interface SearchQueryOptions {
  limit?: number;
  folderId?: string;
  inboxStatus?: 'all' | 'captured' | 'processing' | 'processed';
}

/** 检索结果：命中项 + 服务端检索策略。 */
export interface SearchResponse {
  items: SearchHit[];
  strategy: string;
}

export const searchApi = {
  async query(q: string, options: SearchQueryOptions = {}): Promise<SearchResponse> {
    const payload = await http.getFull<{ data?: SearchHit[]; meta?: { strategy?: string } }>('/search', { query: { q, limit: options.limit, folderId: options.folderId, inboxStatus: options.inboxStatus } });
    return { items: payload?.data ?? [], strategy: payload?.meta?.strategy ?? 'unknown' };
  },
};

/** 图谱节点。 */
export interface GraphNode {
  id: string;
  title: string;
  folderId: string | null;
  degree: number;
  wordCount: number;
}

/** 图谱边。 */
export interface GraphEdge {
  source: string;
  target: string;
}

/** 悬空链接（目标笔记不存在）。 */
export interface GraphDanglingLink {
  targetTitle: string;
  referenceCount: number;
}

/** 图谱统计。 */
export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  isolatedCount: number;
}

/** 图谱快照（GET /graph）。 */
export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  dangling: GraphDanglingLink[];
  stats: GraphStats;
}

export const graphApi = {
  get: (options: RequestOptions = {}): Promise<GraphSnapshot> => http.get<GraphSnapshot>('/graph', options),
};

/** 库概览统计（GET /meta/overview）。 */
export interface MetaOverview {
  noteCount: number;
  folderCount: number;
  tagCount: number;
  linkCount: number;
  danglingCount: number;
  totalWords: number;
  danglingLinks: GraphDanglingLink[];
}

export const metaApi = {
  overview: (options: RequestOptions = {}): Promise<MetaOverview> => http.get<MetaOverview>('/meta/overview', options),
};

export const healthApi = {
  /** 探针不在 /api 之下，因此用 base: '' 走根路径 */
  probe: (options: RequestOptions = {}): Promise<unknown> => http.get('/health', { base: '', timeout: 4000, retries: 0, ...options }),
};
