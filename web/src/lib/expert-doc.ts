/**
 * 专家文档契约（E1，`doc/AI/地基/专家-Skill-MCP重构方案.md` §3.2）。
 *
 * 单一事实源：web 侧任何地方要读写专家，都从这里拿类型与形态转换，
 * 与 Rust `expert_normalize` / `parse_expert_markdown` 的输出逐字段对齐。
 *
 * 契约要点（E1 起）：
 *  - 落盘是 `<Vault>/.lattice/experts/<id>.md`，frontmatter 扁平键 + 正文 = systemPrompt；
 *  - 嵌套读写形态：`capabilities.*` / `routing.*` / `skills[{id,enabled,mode}]`；
 *  - 已退役字段：`scope`（并入 `capabilities.scopeExclude`）、`routing.confidenceThreshold`、
 *    `skills[].priority` / `skills[].config`——读写两侧都不再产生。
 */

/** 上下文范围词表（能力闸，运行时决定可读哪些上下文）。 */
export const CONTEXT_OPTIONS = [
  { id: 'current-note', label: '当前笔记' },
  { id: 'project', label: '当前项目' },
  { id: 'vault', label: '知识库' },
  { id: 'inbox', label: 'Inbox' },
] as const;

/** 工具面词表：写工具由 writePolicy 二次把闸（策略只收紧不放宽）。 */
export const TOOL_OPTIONS = [
  { id: 'read', label: '读取' },
  { id: 'search', label: '检索' },
  { id: 'write', label: '写入' },
  { id: 'mcp', label: '外部工具' },
] as const;

export const WRITE_POLICY_OPTIONS = [
  { id: 'disabled', label: '只读', hint: '写工具从工具面剥离' },
  { id: 'confirm', label: '写入前确认', hint: 'L0/L1 直执，L2/L3 等你确认' },
  { id: 'auto', label: '任务模式自动写入', hint: 'L0-L2 直执，删除/外发仍确认' },
] as const;

/** 技能绑定模式：preload 开局注入全文 / discoverable 只常驻目录、模型按需加载。 */
export const SKILL_MODE_OPTIONS = [
  { id: 'preload', label: '预载全文', hint: '会话开始即注入（≤6000 字）' },
  { id: 'discoverable', label: '按需加载', hint: '只常驻名称与说明' },
] as const;

/** system 文本上限（Rust `EXPERT_MAX_PROMPT_CHARS` 同值）。 */
export const EXPERT_PROMPT_MAX_CHARS = 12_000;
/** 轮数上限（Rust `expert_clamp(.., 1, 12)` 同值）。 */
export const EXPERT_MAX_ROUNDS = 12;
/** 单条排除路径长度上限（Rust 同值）。 */
const SCOPE_PATH_MAX_CHARS = 200;

export type WritePolicy = (typeof WRITE_POLICY_OPTIONS)[number]['id'];
export type SkillMode = (typeof SKILL_MODE_OPTIONS)[number]['id'];

/**
 * 契约类型：唯一事实源在 `web/src/api/experts.ts`（对齐 Rust `expert_normalize`），
 * 本模块只做「编辑态」与「服务端文档」之间的形态转换，不再另立一套字段。
 */
import type {
  Expert as ExpertDoc,
  ExpertCapabilities,
  ExpertRouting,
  ExpertSkillBinding,
  ExpertSkillMode,
  Skill as SkillDoc,
} from '../api/experts.ts';

export type { ExpertDoc, ExpertCapabilities, ExpertRouting, ExpertSkillBinding, ExpertSkillMode, SkillDoc };

/** 编辑态绑定：字段全部必填，避免表单里到处判空。 */
export interface DraftBinding {
  id: string;
  enabled: boolean;
  mode: ExpertSkillMode;
}

/** 编辑态能力范围（服务端同名字段全部可选，这里落成必填）。 */
export interface DraftCapabilities {
  context: string[];
  tools: string[];
  writePolicy: WritePolicy;
  maxRounds: number;
  scopeExclude: string[];
}

/** 编辑态路由（description 是主路由，这里只保留「快速建议」增强）。 */
export interface DraftRouting {
  keywords: string[];
  priority: number;
}

/** 编辑态：所有字段必填（缺失值在 `draftFromExpert` 里已回落）。 */
export interface ExpertDraft {
  id: string;
  name: string;
  description: string;
  version: string;
  icon: string;
  enabled: boolean;
  systemPrompt: string;
  skills: DraftBinding[];
  capabilities: DraftCapabilities;
  routing: DraftRouting;
  source?: string;
}

const DEFAULT_PRIORITY = 50;
const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_SCOPE_EXCLUDE = ['.lattice/', '_templates/', '.fc/'];

/** 新建专家的初始态（与 Rust 默认值一致：只读+检索、确认写、6 轮）。 */
export function emptyExpertDraft(): ExpertDraft {
  return {
    id: '',
    name: '',
    description: '',
    version: '2.0.0',
    icon: 'sparkles',
    enabled: true,
    systemPrompt: '',
    skills: [],
    capabilities: {
      context: ['current-note', 'project', 'vault'],
      tools: ['read', 'search'],
      writePolicy: 'confirm',
      maxRounds: DEFAULT_MAX_ROUNDS,
      scopeExclude: [...DEFAULT_SCOPE_EXCLUDE],
    },
    routing: { keywords: [], priority: DEFAULT_PRIORITY },
  };
}

/** 逗号族分隔（中英文逗号与顿号），用于关键词/路径等列表输入。 */
export function splitList(value: string): string[] {
  return value
    .split(/[、,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 列表 → 输入框文本。 */
export function joinList(values: string[] | undefined): string {
  return (values ?? []).join('、');
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

/** 技能绑定归一：兼容 `"id"` / `"id@preload"` 字符串与 `{id,enabled,mode}` 对象。 */
export function normalizeBinding(raw: unknown): DraftBinding | null {
  if (typeof raw === 'string') {
    const [id, mode] = raw.split('@');
    const trimmed = (id ?? '').trim();
    if (!trimmed) return null;
    return { id: trimmed, enabled: true, mode: mode === 'discoverable' ? 'discoverable' : 'preload' };
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  return {
    id,
    enabled: record.enabled !== false,
    mode: record.mode === 'discoverable' ? 'discoverable' : 'preload',
  };
}

/** 文档 → 编辑态。缺失字段一律回落到默认值，保证表单永远可编辑。 */
export function draftFromExpert(expert: ExpertDoc): ExpertDraft {
  const base = emptyExpertDraft();
  const capabilities = (expert.capabilities ?? {}) as Partial<DraftCapabilities>;
  const routing = (expert.routing ?? {}) as Partial<DraftRouting>;
  const bindings = Array.isArray(expert.skills)
    ? expert.skills.map(normalizeBinding).filter((item): item is DraftBinding => item !== null)
    : [];
  const unique: DraftBinding[] = [];
  for (const binding of bindings) {
    if (!unique.some((item) => item.id === binding.id)) unique.push(binding);
  }
  return {
    id: expert.id ?? base.id,
    name: (expert.name ?? '').trim() || expert.id || '',
    description: (expert.description ?? '').trim(),
    version: (expert.version ?? base.version).trim() || base.version,
    icon: (expert.icon ?? base.icon).trim() || base.icon,
    enabled: expert.enabled !== false,
    systemPrompt: expert.systemPrompt ?? '',
    skills: unique,
    capabilities: {
      context: asStringList(capabilities.context).length ? asStringList(capabilities.context) : [...base.capabilities.context],
      tools: asStringList(capabilities.tools).length ? asStringList(capabilities.tools) : [...base.capabilities.tools],
      writePolicy: (WRITE_POLICY_OPTIONS.some((option) => option.id === capabilities.writePolicy)
        ? capabilities.writePolicy
        : base.capabilities.writePolicy) as WritePolicy,
      maxRounds: clampNumber(capabilities.maxRounds, base.capabilities.maxRounds, 1, EXPERT_MAX_ROUNDS),
      scopeExclude: Array.isArray(capabilities.scopeExclude)
        ? asStringList(capabilities.scopeExclude)
        : [...base.capabilities.scopeExclude],
    },
    routing: {
      keywords: asStringList(routing.keywords),
      priority: clampNumber(routing.priority, DEFAULT_PRIORITY, 0, 100),
    },
    source: typeof expert.source === 'string' ? expert.source : undefined,
  };
}

/** 编辑态 → 保存载荷（Rust `expert_normalize` 的输入形态）。 */
export function payloadFromDraft(draft: ExpertDraft): Record<string, unknown> {
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    version: draft.version.trim() || '1.0.0',
    icon: draft.icon.trim() || 'sparkles',
    enabled: draft.enabled,
    systemPrompt: draft.systemPrompt.slice(0, EXPERT_PROMPT_MAX_CHARS),
    skills: draft.skills.map((binding) => ({ id: binding.id, enabled: binding.enabled !== false, mode: binding.mode })),
    capabilities: {
      context: [...draft.capabilities.context],
      tools: [...draft.capabilities.tools],
      writePolicy: draft.capabilities.writePolicy,
      maxRounds: clampNumber(draft.capabilities.maxRounds, DEFAULT_MAX_ROUNDS, 1, EXPERT_MAX_ROUNDS),
      scopeExclude: draft.capabilities.scopeExclude
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 40)
        .map((item) => item.slice(0, SCOPE_PATH_MAX_CHARS)),
    },
    routing: {
      keywords: draft.routing.keywords.slice(0, 40),
      priority: clampNumber(draft.routing.priority, DEFAULT_PRIORITY, 0, 100),
    },
  };
}

/** 内置专家不可就地改：复制成工作区副本（id 加 `-custom`，已带后缀则递增）。 */
export function copyDraft(draft: ExpertDraft): ExpertDraft {
  const baseId = draft.id.trim() || 'expert';
  const id = baseId.endsWith('-custom') ? `${baseId}-2` : `${baseId}-custom`;
  return {
    ...draft,
    id,
    name: `${draft.name.trim() || baseId} 副本`,
    skills: draft.skills.map((binding) => ({ ...binding })),
    capabilities: {
      ...draft.capabilities,
      context: [...draft.capabilities.context],
      tools: [...draft.capabilities.tools],
      scopeExclude: [...draft.capabilities.scopeExclude],
    },
    routing: { ...draft.routing, keywords: [...draft.routing.keywords] },
    source: undefined,
  };
}

/** 专家落盘路径（E1 起是 `.md`，正文即 systemPrompt）。 */
export function expertFilePath(id: string): string {
  return `.lattice/experts/${id.trim()}.md`;
}

/** Skill 目录路径（删除用，递归）。 */
export function skillDirectoryPath(id: string): string {
  return `.lattice/skills/${id.trim()}/`;
}

/** 写入策略 → 人话。 */
export function describeWritePolicy(policy: string | undefined): string {
  return WRITE_POLICY_OPTIONS.find((option) => option.id === policy)?.label ?? '写入前确认';
}

/** 技能绑定 → 人话（"检索方法·预载"）。 */
export function describeBinding(binding: DraftBinding): string {
  return binding.mode === 'discoverable' ? '按需加载' : '预载全文';
}

/** 只在词表内的工具/上下文才回写，避免手改出脏值。 */
export function toggleList(values: string[], id: string): string[] {
  return values.includes(id) ? values.filter((item) => item !== id) : [...values, id];
}
