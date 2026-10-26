import { http, type RequestOptions } from './client.ts';

/**
 * 专家 / Skill 的唯一契约（E1：三处重复定义合并到这里）。
 *
 * 存储形态是 Markdown（`<Vault>/.lattice/experts/<id>.md`）：frontmatter 是配置，
 * 正文就是 systemPrompt。IPC 出口把 frontmatter 摊平成下面的嵌套结构，
 * 保存时再写回 Markdown——前端只认这一份形状。
 */

/** 写策略：disabled 禁写 / confirm 按风险确认 / auto 允许 L2 直执（删除仍需确认）。 */
export type ExpertWritePolicy = 'disabled' | 'confirm' | 'auto';

/**
 * 技能绑定模式：preload = 专家启动即把 SKILL.md 全文注入 system；
 * discoverable = 只把 name+description 放进目录，模型按需加载（E2 渐进披露）。
 */
export type ExpertSkillMode = 'preload' | 'discoverable';

/** 专家（GET /experts）。 */
export interface Expert {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  icon?: string;
  enabled?: boolean;
  /** 正文 = systemPrompt（Markdown 正文，支持 {{today}} / {{vaultName}}）。 */
  systemPrompt?: string;
  skills?: ExpertSkillBinding[];
  capabilities?: ExpertCapabilities;
  routing?: ExpertRouting;
  /** 列表口径的绑定数量（详情返回 skills 明细）。 */
  skillCount?: number;
  source?: 'builtin' | 'workspace' | string;
  [key: string]: unknown;
}

export interface ExpertSkillBinding {
  id: string;
  enabled?: boolean;
  mode?: ExpertSkillMode;
  /** 详情口径嵌入的技能摘要；列表口径只有 available。 */
  skill?: Skill;
  available?: boolean;
}

export interface ExpertCapabilities {
  /** 上下文范围闸：current-note / project / vault / inbox。 */
  context?: string[];
  /** 工具面白名单：read / search / write / mcp（或显式工具名）。 */
  tools?: string[];
  writePolicy?: ExpertWritePolicy;
  /** 轮数上限（1–12，只会收紧会话预算）。 */
  maxRounds?: number;
  /** 写路径前缀黑名单（原 scope.exclude）。 */
  scopeExclude?: string[];
  /** 预留扩展位：内核新增字段时不至于让消费侧类型硬崩。 */
  [key: string]: unknown;
}

export interface ExpertRouting {
  keywords?: string[];
  priority?: number;
}

/**
 * 技能（GET /experts/skills）。E2 起对齐 Agent Skills 规范：
 * `name` 必须是目录名（slug），`description` 是模型是否加载它的唯一依据；
 * 中文名放 `metadata.lattice.title`（IPC 出口摊平为 `title`）。
 */
export interface Skill {
  id: string;
  /** 规范字段：与目录名一致 */
  name?: string;
  /** 展示名（metadata.lattice.title） */
  title?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  /** 规范字段 allowed-tools（预批准，不是限制） */
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  version?: string;
  enabled?: boolean;
  content?: string;
  contentHash?: string;
  source?: string;
  [key: string]: unknown;
}

/** 导入来源：粘贴文本 / 本地路径 / 链接。 */
export interface SkillImportInput {
  source: 'text' | 'path' | 'url';
  value: string;
}

/** 专家路由请求载荷。 */
export interface ExpertRouteInput {
  message: string;
  excludeId?: string | null;
  [key: string]: unknown;
}

export const expertsApi = {
  list: (options: RequestOptions = {}): Promise<Expert[]> => http.get<Expert[]>('/experts', options),
  route: (input: ExpertRouteInput, options: RequestOptions = {}): Promise<Expert> => http.post<Expert>('/experts/route', input, { retries: 0, ...options }),
  get: (id: string, options: RequestOptions = {}): Promise<Expert> => http.get<Expert>(`/experts/${encodeURIComponent(id)}`, options),
  create: (input: Record<string, unknown>, options: RequestOptions = {}): Promise<Expert> => http.post<Expert>('/experts', input, { retries: 0, ...options }),
  update: (id: string, input: Record<string, unknown>, options: RequestOptions = {}): Promise<Expert> => http.put<Expert>(`/experts/${encodeURIComponent(id)}`, input, { retries: 0, ...options }),
  remove: (id: string, options: RequestOptions = {}): Promise<unknown> => http.delete(`/experts/${encodeURIComponent(id)}`, { retries: 0, ...options }),
  listSkills: (options: RequestOptions = {}): Promise<Skill[]> => http.get<Skill[]>('/experts/skills', options),
  getSkill: (id: string, options: RequestOptions = {}): Promise<Skill> => http.get<Skill>(`/experts/skills/${encodeURIComponent(id)}`, options),
  createSkill: (input: Record<string, unknown>, options: RequestOptions = {}): Promise<Skill> => http.post<Skill>('/experts/skills', input, { retries: 0, ...options }),
  updateSkill: (id: string, input: Record<string, unknown>, options: RequestOptions = {}): Promise<Skill> => http.put<Skill>(`/experts/skills/${encodeURIComponent(id)}`, input, { retries: 0, ...options }),
  removeSkill: (id: string, options: RequestOptions = {}): Promise<unknown> => http.delete(`/experts/skills/${encodeURIComponent(id)}`, { retries: 0, ...options }),
  /** 导入：只解析预览（返回规范化文档），落盘仍走 createSkill/updateSkill 的确认流程。 */
  importSkill: (input: SkillImportInput, options: RequestOptions = {}): Promise<{ document: Skill; markdown: string }> => http.post('/experts/skills/import', input, { retries: 0, ...options }),
  /** 导出：返回规范化 SKILL.md 全文与 references 清单。 */
  exportSkill: (id: string, options: RequestOptions = {}): Promise<{ id: string; filename: string; markdown: string; references: string[] }> => http.get(`/experts/skills/${encodeURIComponent(id)}/export`, options),
};
