import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { BookOpen, Check, Copy, Layers3, Link2, Plus, RefreshCw, Save, Search, Settings2, ShieldCheck, Sparkles, Trash2, Wrench, X } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { expertsApi, type Expert as ApiExpert, type Skill as ApiSkill } from '../api/experts.ts';
import { McpToolsCenter } from '../settings/SettingsModal.tsx';
import type { FileConfirmationResult, FileOperationInput } from '../hooks/useFileConfirmation.tsx';

export type ManagerTab = 'experts' | 'skills' | 'mcp';

interface Expert extends ApiExpert {
  description?: string;
  enabled?: boolean;
  source?: string;
  systemPrompt?: string;
  skillCount?: number;
  skills?: Array<{ id: string; enabled?: boolean; priority?: number; config?: Record<string, unknown> }>;
  capabilities?: { context?: string[]; tools?: string[]; writePolicy?: string; maxRounds?: number };
  routing?: { keywords?: string[]; priority?: number; confidenceThreshold?: number };
  scope?: { include?: string[]; exclude?: string[] };
}

interface Skill extends ApiSkill {
  description?: string;
  version?: string;
  triggers?: string[];
  tools?: string[];
  permissions?: string[];
  enabled?: boolean;
  content?: string;
  source?: string;
}

interface ExpertDraft {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  systemPrompt: string;
  scope: { include: string[]; exclude: string[] };
  skills: Array<{ id: string; enabled: boolean; priority: number; config: Record<string, unknown> }>;
  capabilities: { context: string[]; tools: string[]; writePolicy: string; maxRounds: number };
  routing: { keywords: string[]; priority: number; confidenceThreshold: number };
  source?: string;
}

interface SkillDraft {
  id: string;
  name: string;
  description: string;
  version: string;
  triggers: string[];
  tools: string[];
  permissions: string[];
  enabled: boolean;
  content: string;
  source?: string;
}

interface ExpertManagerProps {
  open: boolean;
  initialTab?: ManagerTab;
  onClose: () => void;
  experts: Expert[];
  skills: Skill[];
  activeExpertId: string;
  onSelectExpert: (expertId: string) => void;
  onChanged?: () => void | Promise<unknown>;
  onConfirmFileOperation?: (operation: FileOperationInput) => Promise<FileConfirmationResult>;
  vaultDir?: string;
}

const EMPTY_EXPERT: ExpertDraft = {
  id: '', name: '', description: '', enabled: true, systemPrompt: '',
  scope: { include: [], exclude: [] }, skills: [],
  capabilities: { context: ['current-note', 'project', 'vault'], tools: ['read', 'search'], writePolicy: 'confirm', maxRounds: 6 },
  routing: { keywords: [], priority: 50, confidenceThreshold: 0.72 },
};

const EMPTY_SKILL: SkillDraft = {
  id: '', name: '', description: '', version: '1.0.0', triggers: [], tools: ['read'], permissions: ['read'], enabled: true,
  content: '# 新 Skill\n\n## 工作流程\n\n描述 AI 应该如何完成这项工作。\n',
};

const CONTEXT_OPTIONS = [
  { id: 'current-note', label: '当前笔记' },
  { id: 'project', label: '当前项目' },
  { id: 'vault', label: '知识库' },
];

const TOOL_OPTIONS = [
  { id: 'read', label: '读取' },
  { id: 'search', label: '检索' },
  { id: 'write', label: '写入' },
  { id: 'mcp', label: '外部工具' },
];

export default function ExpertManager({ open, initialTab = 'experts', onClose, experts, skills, activeExpertId, onSelectExpert, onChanged, onConfirmFileOperation, vaultDir }: ExpertManagerProps) {
  const [tab, setTab] = useState<ManagerTab>(initialTab);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [expertDraft, setExpertDraft] = useState<ExpertDraft | null>(null);
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setQuery('');
    setExpertDraft(null);
    setSkillDraft(null);
    setNotice('');
  }, [initialTab, open]);

  useEffect(() => {
    const items = tab === 'experts' ? experts : skills;
    if (tab === 'mcp') return;
    if (!items.some((item) => item.id === selectedId)) setSelectedId(items[0]?.id ?? '');
  }, [experts, selectedId, skills, tab]);

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const items = tab === 'experts' ? experts : tab === 'skills' ? skills : [];
    if (!normalized) return items;
    return items.filter((item) => `${item.id} ${item.name ?? ''} ${item.description ?? ''}`.toLowerCase().includes(normalized));
  }, [experts, query, skills, tab]);

  const selectedExpert = experts.find((expert) => expert.id === selectedId) ?? null;
  const selectedSkill = skills.find((skill) => skill.id === selectedId) ?? null;

  const selectTab = (next: ManagerTab) => {
    setTab(next);
    setQuery('');
    setExpertDraft(null);
    setSkillDraft(null);
    setNotice('');
    setSelectedId(next === 'experts' ? experts[0]?.id ?? '' : next === 'skills' ? skills[0]?.id ?? '' : '');
  };

  const refresh = async () => {
    setBusy(true);
    try {
      await onChanged?.();
      setNotice('配置已刷新');
    } catch (error) {
      setNotice((error as Error)?.message ?? '刷新失败');
    } finally {
      setBusy(false);
    }
  };

  const newExpert = () => {
    setTab('experts');
    setSelectedId('');
    setExpertDraft({ ...EMPTY_EXPERT, scope: { ...EMPTY_EXPERT.scope }, capabilities: { ...EMPTY_EXPERT.capabilities }, routing: { ...EMPTY_EXPERT.routing } });
    setNotice('');
  };

  const newSkill = () => {
    setTab('skills');
    setSelectedId('');
    setSkillDraft({ ...EMPTY_SKILL, triggers: [], tools: ['read'], permissions: ['read'] });
    setNotice('');
  };

  const editExpert = (expert: Expert) => {
    setSelectedId(expert.id);
    setExpertDraft({
      ...EMPTY_EXPERT,
      ...expert,
      id: expert.id,
      name: expert.name ?? '',
      description: expert.description ?? '',
      systemPrompt: expert.systemPrompt ?? '',
      scope: { include: expert.scope?.include ?? [], exclude: expert.scope?.exclude ?? [] },
      skills: (expert.skills ?? []).map((binding) => ({ id: binding.id, enabled: binding.enabled !== false, priority: binding.priority ?? 50, config: binding.config ?? {} })),
      capabilities: { ...EMPTY_EXPERT.capabilities, ...expert.capabilities },
      routing: { ...EMPTY_EXPERT.routing, ...expert.routing },
    });
  };

  const editSkill = async (skill: Skill) => {
    setSelectedId(skill.id);
    setBusy(true);
    try {
      const detail = await expertsApi.getSkill(skill.id);
      setSkillDraft({ ...EMPTY_SKILL, ...(detail as unknown as SkillDraft), id: skill.id, name: detail.name ?? skill.name ?? '' });
    } catch (error) {
      setNotice((error as Error)?.message ?? 'Skill 详情加载失败');
    } finally {
      setBusy(false);
    }
  };

  const copyExpert = (expert: Expert) => {
    editExpert({ ...expert, id: `${expert.id}-custom`, name: `${expert.name ?? expert.id} 副本`, source: undefined });
    setExpertDraft((current) => current ? { ...current, id: `${expert.id}-custom`, name: `${expert.name ?? expert.id} 副本`, source: undefined } : current);
  };

  const copySkill = (skill: Skill) => {
    setSelectedId('');
    setSkillDraft({ ...EMPTY_SKILL, ...skill, id: `${skill.id}-custom`, name: `${skill.name ?? skill.id} 副本`, source: undefined, content: skill.content ?? EMPTY_SKILL.content });
  };

  const saveExpert = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!expertDraft?.id.trim() || !expertDraft.name.trim()) { setNotice('请填写专家 ID 和名称'); return; }
    setBusy(true);
    try {
      const existing = experts.find((item) => item.id === expertDraft.id);
      const payload = {
        id: expertDraft.id,
        name: expertDraft.name.trim(), description: expertDraft.description.trim(), enabled: expertDraft.enabled,
        systemPrompt: expertDraft.systemPrompt, scope: expertDraft.scope, skills: expertDraft.skills,
        capabilities: expertDraft.capabilities, routing: expertDraft.routing,
      };
      const confirmation = await onConfirmFileOperation?.({
        vaultDir,
        actions: [{ type: existing ? 'update' : 'create', path: `.lattice/experts/${expertDraft.id}.json`, contentSummary: `${existing ? '更新' : '创建'}专家「${expertDraft.name.trim()}」` }],
        impact: '修改 1 个 .lattice 专家配置文件，影响 AI 路由与权限策略',
      });
      if (!confirmation?.confirmed) return;
      if (existing) await expertsApi.update(existing.id, { ...payload, ...confirmation });
      else await expertsApi.create({ ...payload, ...confirmation });
      await onChanged?.();
      setSelectedId(expertDraft.id);
      setExpertDraft(null);
      setNotice('专家已保存');
    } catch (error) {
      setNotice((error as Error)?.message ?? '专家保存失败');
    } finally {
      setBusy(false);
    }
  };

  const saveSkill = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!skillDraft?.id.trim() || !skillDraft.name.trim() || !skillDraft.content.trim()) { setNotice('请填写 Skill ID、名称和内容'); return; }
    setBusy(true);
    try {
      const existing = skills.find((item) => item.id === skillDraft.id);
      const payload = { id: skillDraft.id, name: skillDraft.name.trim(), description: skillDraft.description.trim(), version: skillDraft.version, triggers: skillDraft.triggers, tools: skillDraft.tools, permissions: skillDraft.permissions, enabled: skillDraft.enabled, content: skillDraft.content.trim() };
      const confirmation = await onConfirmFileOperation?.({
        vaultDir,
        actions: [
          { type: existing ? 'update' : 'create', path: `.lattice/skills/${skillDraft.id}/skill.json`, contentSummary: `${existing ? '更新' : '创建'} Skill 清单` },
          { type: existing ? 'update' : 'create', path: `.lattice/skills/${skillDraft.id}/SKILL.md`, contentSummary: `写入 Skill「${skillDraft.name.trim()}」正文` },
        ],
        impact: '修改 2 个 .lattice Skill 文件，影响 AI 工作方法',
      });
      if (!confirmation?.confirmed) return;
      if (existing) await expertsApi.updateSkill(existing.id, { ...payload, ...confirmation });
      else await expertsApi.createSkill({ ...payload, ...confirmation });
      await onChanged?.();
      setSelectedId(skillDraft.id);
      setSkillDraft(null);
      setNotice('Skill 已保存');
    } catch (error) {
      setNotice((error as Error)?.message ?? 'Skill 保存失败');
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (item: Expert | Skill, kind: ManagerTab) => {
    if (item.source !== 'workspace') return;
    setBusy(true);
    try {
      const isExpert = kind === 'experts';
      const confirmation = await onConfirmFileOperation?.({
        vaultDir,
        type: 'delete',
        path: isExpert ? `.lattice/experts/${item.id}.json` : `.lattice/skills/${item.id}/`,
        contentSummary: `删除${isExpert ? '专家' : 'Skill'}「${item.name ?? item.id}」`,
        impact: isExpert ? '移除 1 个专家配置' : '递归删除 1 个 Skill 目录及其中的配置文件',
        requiresSecondConfirmation: true,
      });
      if (!confirmation?.confirmed) return;
      if (isExpert) await expertsApi.remove(item.id, { body: confirmation });
      else await expertsApi.removeSkill(item.id, { body: confirmation });
      await onChanged?.();
      setSelectedId('');
      setNotice(`${isExpert ? '专家' : 'Skill'}已删除`);
    } catch (error) {
      setNotice((error as Error)?.message ?? '删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="专家、Skill 与 MCP" ariaLabel="专家、Skill 与 MCP" className="expert-manager-modal">
      <div className="expert-manager">
        <header className="expert-manager__header">
          <div className="expert-manager__title"><span className="expert-manager__mark"><Sparkles size={16} /></span><div><strong>专家、Skill 与 MCP</strong><small>配置 AI 如何工作和使用工具</small></div></div>
          <nav className="expert-manager__tabs" aria-label="专家、Skill 与 MCP"><button type="button" className={tab === 'experts' ? 'is-active' : ''} onClick={() => selectTab('experts')}><Sparkles size={15} />专家<span>{experts.length}</span></button><button type="button" className={tab === 'skills' ? 'is-active' : ''} onClick={() => selectTab('skills')}><Wrench size={15} />Skill<span>{skills.length}</span></button><button type="button" className={tab === 'mcp' ? 'is-active' : ''} onClick={() => selectTab('mcp')}><Settings2 size={15} />MCP</button></nav>
          <div className="expert-manager__header-actions"><button type="button" className="icon-btn" onClick={() => void refresh()} disabled={busy} aria-label="刷新" title="刷新"><RefreshCw size={16} className={busy ? 'is-spinning' : undefined} /></button><button type="button" className="icon-btn" onClick={onClose} aria-label="关闭" title="关闭"><X size={18} /></button></div>
        </header>
        <div className={`expert-manager__body${tab === 'mcp' ? ' is-mcp' : ''}`}>
          {tab !== 'mcp' ? <aside className="expert-manager__list-pane">
            <div className="expert-manager__list-head"><div><strong>{tab === 'experts' ? '专家目录' : 'Skill 目录'}</strong><small>{tab === 'experts' ? '选择后在右侧配置' : '可复用的工作方法'}</small></div><button type="button" className="icon-btn" onClick={tab === 'experts' ? newExpert : newSkill} aria-label={tab === 'experts' ? '添加专家' : '添加 Skill'} title={tab === 'experts' ? '添加专家' : '添加 Skill'}><Plus size={16} /></button></div>
            <label className="expert-manager__search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === 'experts' ? '搜索专家' : '搜索 Skill'} aria-label={tab === 'experts' ? '搜索专家' : '搜索 Skill'} /></label>
            <div className="expert-manager__items" role="listbox" aria-label={tab === 'experts' ? '专家列表' : 'Skill 列表'}>{filteredItems.map((item) => <button type="button" role="option" aria-selected={selectedId === item.id} className={`expert-manager__item ${selectedId === item.id ? 'is-selected' : ''}`} key={item.id} onClick={() => { setSelectedId(item.id); setExpertDraft(null); setSkillDraft(null); }}>{tab === 'experts' ? <Sparkles size={15} /> : <BookOpen size={15} />}<span><strong>{item.name || item.id}</strong><small>{item.description || (tab === 'experts' ? '未填写说明' : '未填写说明')}</small></span>{item.source === 'workspace' ? <em>我的</em> : null}</button>)}{!filteredItems.length ? <div className="expert-manager__list-empty">没有匹配项</div> : null}</div>
          </aside> : null}
          <section className="expert-manager__detail" aria-label={tab === 'experts' ? '专家配置' : tab === 'skills' ? 'Skill 配置' : 'MCP 工具中心'}>
            {notice ? <div className="expert-manager__notice" role="status">{notice}</div> : null}
            {tab === 'mcp' ? <div className="expert-manager__mcp"><McpToolsCenter vaultPath={vaultDir ?? ''} /></div> : tab === 'experts' ? (expertDraft ? <ExpertForm draft={expertDraft} skills={skills} busy={busy} onChange={setExpertDraft} onCancel={() => setExpertDraft(null)} onSubmit={saveExpert} /> : selectedExpert ? <ExpertSummary expert={selectedExpert} active={selectedExpert.id === activeExpertId} onUse={() => { onSelectExpert(selectedExpert.id); onClose(); }} onEdit={() => editExpert(selectedExpert)} onCopy={() => copyExpert(selectedExpert)} onRemove={() => void removeItem(selectedExpert, 'experts')} /> : <ManagerEmpty kind="experts" onCreate={newExpert} />) : (skillDraft ? <SkillForm draft={skillDraft} busy={busy} onChange={setSkillDraft} onCancel={() => setSkillDraft(null)} onSubmit={saveSkill} /> : selectedSkill ? <SkillSummary skill={selectedSkill} onEdit={() => void editSkill(selectedSkill)} onCopy={() => copySkill(selectedSkill)} onRemove={() => void removeItem(selectedSkill, 'skills')} /> : <ManagerEmpty kind="skills" onCreate={newSkill} />)}
          </section>
        </div>
      </div>
    </Modal>
  );
}

function ExpertSummary({ expert, active, onUse, onEdit, onCopy, onRemove }: { expert: Expert; active: boolean; onUse: () => void; onEdit: () => void; onCopy: () => void; onRemove: () => void }) {
  const contexts = expert.capabilities?.context ?? [];
  const tools = expert.capabilities?.tools ?? [];
  return <div className="expert-manager__summary"><div className="expert-manager__detail-head"><div><span className="expert-manager__eyebrow">EXPERT PROFILE</span><h1>{expert.name || expert.id}</h1><p>{expert.description || '还没有填写这个专家的工作说明。'}</p></div><span className={`expert-manager__status ${expert.enabled === false ? 'is-off' : ''}`}><span />{expert.enabled === false ? '已停用' : active ? '当前使用' : '已启用'}</span></div><div className="expert-manager__facts"><div><Layers3 size={15} /><span>Skill</span><strong>{expert.skillCount ?? expert.skills?.length ?? 0}</strong></div><div><ShieldCheck size={15} /><span>写入策略</span><strong>{expert.capabilities?.writePolicy === 'disabled' ? '只读' : expert.capabilities?.writePolicy === 'auto' ? '自动' : '需确认'}</strong></div><div><Link2 size={15} /><span>上下文</span><strong>{contexts.length || 0} 项</strong></div><div><Settings2 size={15} /><span>工具</span><strong>{tools.length || 0} 项</strong></div></div><div className="expert-manager__summary-block"><span className="expert-manager__eyebrow">工作指令</span><p className="expert-manager__prompt">{expert.systemPrompt?.trim() || '未设置额外指令。编辑专家，告诉它应该如何判断、处理和汇报。'}</p></div><div className="expert-manager__summary-actions"><button type="button" className="btn btn--sm btn--primary" onClick={onUse}><Check size={15} />{active ? '继续使用' : '使用这个专家'}</button><button type="button" className="btn btn--sm" onClick={onEdit}>编辑配置</button><button type="button" className="icon-btn" onClick={onCopy} title="复制专家" aria-label="复制专家"><Copy size={15} /></button><button type="button" className="icon-btn icon-btn--danger" onClick={onRemove} disabled={expert.source !== 'workspace'} title={expert.source === 'workspace' ? '删除专家' : '内置专家不可删除'} aria-label="删除专家"><Trash2 size={15} /></button></div></div>;
}

function SkillSummary({ skill, onEdit, onCopy, onRemove }: { skill: Skill; onEdit: () => void; onCopy: () => void; onRemove: () => void }) {
  return <div className="expert-manager__summary"><div className="expert-manager__detail-head"><div><span className="expert-manager__eyebrow">REUSABLE METHOD</span><h1>{skill.name || skill.id}</h1><p>{skill.description || '还没有填写这个 Skill 的用途。'}</p></div><span className={`expert-manager__status ${skill.enabled === false ? 'is-off' : ''}`}><span />{skill.enabled === false ? '已停用' : '已启用'}</span></div><div className="expert-manager__facts"><div><Wrench size={15} /><span>工具</span><strong>{skill.tools?.length ?? 0} 项</strong></div><div><Search size={15} /><span>触发词</span><strong>{skill.triggers?.length ?? 0} 个</strong></div><div><BookOpen size={15} /><span>版本</span><strong>{skill.version || '1.0.0'}</strong></div></div><div className="expert-manager__summary-block"><span className="expert-manager__eyebrow">Skill 正文</span><pre className="expert-manager__content-preview">{skill.content?.trim() || '还没有 Skill 正文。'}</pre></div><div className="expert-manager__summary-actions"><button type="button" className="btn btn--sm btn--primary" onClick={onEdit}>编辑 Skill</button><button type="button" className="icon-btn" onClick={onCopy} title="复制 Skill" aria-label="复制 Skill"><Copy size={15} /></button><button type="button" className="icon-btn icon-btn--danger" onClick={onRemove} disabled={skill.source !== 'workspace'} title={skill.source === 'workspace' ? '删除 Skill' : '内置 Skill 不可删除'} aria-label="删除 Skill"><Trash2 size={15} /></button></div></div>;
}

function ManagerEmpty({ kind, onCreate }: { kind: ManagerTab; onCreate: () => void }) {
  return <div className="expert-manager__empty"><span className="expert-manager__empty-icon">{kind === 'experts' ? <Sparkles size={20} /> : <BookOpen size={20} />}</span><h2>{kind === 'experts' ? '还没有专家' : '还没有 Skill'}</h2><p>{kind === 'experts' ? '创建一个专家，把工作范围和权限固定下来。' : '创建一份 Skill，把可复用的工作方法写下来。'}</p><button type="button" className="btn btn--sm btn--primary" onClick={onCreate}><Plus size={15} />{kind === 'experts' ? '创建专家' : '创建 Skill'}</button></div>;
}

function ExpertForm({ draft, skills, busy, onChange, onCancel, onSubmit }: { draft: ExpertDraft; skills: Skill[]; busy: boolean; onChange: (draft: ExpertDraft | null) => void; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const set = (patch: Partial<ExpertDraft>) => onChange({ ...draft, ...patch });
  const toggle = (key: 'context' | 'tools', id: string) => { const values = draft.capabilities[key]; set({ capabilities: { ...draft.capabilities, [key]: values.includes(id) ? values.filter((item) => item !== id) : [...values, id] } }); };
  const toggleSkill = (id: string) => { const exists = draft.skills.some((item) => item.id === id); set({ skills: exists ? draft.skills.filter((item) => item.id !== id) : [...draft.skills, { id, enabled: true, priority: 50, config: {} }] }); };
  return <form className="expert-manager__form" onSubmit={onSubmit}><div className="expert-manager__detail-head"><div><span className="expert-manager__eyebrow">EXPERT CONFIGURATION</span><h1>{draft.name ? '编辑专家' : '创建专家'}</h1><p>只填写会改变 AI 行为的配置，其他设置保持默认。</p></div><button type="button" className="icon-btn" onClick={onCancel} aria-label="取消编辑" title="取消"><X size={16} /></button></div><div className="expert-manager__form-grid"><label>名称<input value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="例如：Inbox 整理专家" /></label><label>ID<input value={draft.id} disabled={Boolean(draft.source)} onChange={(event) => set({ id: event.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-') })} placeholder="例如：inbox-organizer" /></label></div><label>说明<input value={draft.description} onChange={(event) => set({ description: event.target.value })} placeholder="这个专家负责什么" /></label><label>工作指令<textarea rows={4} value={draft.systemPrompt} onChange={(event) => set({ systemPrompt: event.target.value })} placeholder="告诉 AI 该专家的判断原则和工作方式" /></label><div className="expert-manager__form-grid"><label>写入策略<select value={draft.capabilities.writePolicy} onChange={(event) => set({ capabilities: { ...draft.capabilities, writePolicy: event.target.value } })}><option value="disabled">只读</option><option value="confirm">写入前确认</option><option value="auto">任务模式自动写入</option></select></label><label>路由关键词<input value={draft.routing.keywords.join('、')} onChange={(event) => set({ routing: { ...draft.routing, keywords: splitList(event.target.value) } })} placeholder="整理、归档、Inbox" /></label></div><fieldset><legend>可读取范围</legend><div className="expert-manager__checks">{CONTEXT_OPTIONS.map((item) => <label key={item.id} className={draft.capabilities.context.includes(item.id) ? 'is-checked' : ''}><input type="checkbox" checked={draft.capabilities.context.includes(item.id)} onChange={() => toggle('context', item.id)} /><span>{item.label}</span></label>)}</div></fieldset><fieldset><legend>能力工具</legend><div className="expert-manager__checks">{TOOL_OPTIONS.map((item) => <label key={item.id} className={draft.capabilities.tools.includes(item.id) ? 'is-checked' : ''}><input type="checkbox" checked={draft.capabilities.tools.includes(item.id)} onChange={() => toggle('tools', item.id)} /><span>{item.label}</span></label>)}</div></fieldset><fieldset><legend>绑定 Skill</legend><div className="expert-manager__checks">{skills.length ? skills.map((skill) => <label key={skill.id} className={draft.skills.some((item) => item.id === skill.id) ? 'is-checked' : ''}><input type="checkbox" checked={draft.skills.some((item) => item.id === skill.id)} onChange={() => toggleSkill(skill.id)} /><span>{skill.name || skill.id}</span></label>) : <small>还没有可绑定的 Skill。</small>}</div></fieldset><label className="expert-manager__switch"><input type="checkbox" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} /><span><strong>启用专家</strong><small>停用后不会出现在对话选择器，也不会参与路由建议</small></span></label><div className="expert-manager__form-actions"><button type="button" className="btn btn--sm" onClick={onCancel}>取消</button><button type="submit" className="btn btn--sm btn--primary" disabled={busy}><Save size={15} />保存专家</button></div></form>;
}

function SkillForm({ draft, busy, onChange, onCancel, onSubmit }: { draft: SkillDraft; busy: boolean; onChange: (draft: SkillDraft | null) => void; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const set = (patch: Partial<SkillDraft>) => onChange({ ...draft, ...patch });
  return <form className="expert-manager__form" onSubmit={onSubmit}><div className="expert-manager__detail-head"><div><span className="expert-manager__eyebrow">SKILL CONFIGURATION</span><h1>{draft.name ? '编辑 Skill' : '创建 Skill'}</h1><p>把一套稳定的工作方法写成 AI 可以复用的正文。</p></div><button type="button" className="icon-btn" onClick={onCancel} aria-label="取消编辑" title="取消"><X size={16} /></button></div><div className="expert-manager__form-grid"><label>名称<input value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="例如：会议纪要整理" /></label><label>ID<input value={draft.id} disabled={Boolean(draft.source)} onChange={(event) => set({ id: event.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-') })} placeholder="例如：meeting-summary" /></label></div><label>说明<input value={draft.description} onChange={(event) => set({ description: event.target.value })} placeholder="这项 Skill 解决什么问题" /></label><div className="expert-manager__form-grid"><label>触发词<input value={draft.triggers.join('、')} onChange={(event) => set({ triggers: splitList(event.target.value) })} placeholder="会议纪要、提取行动项" /></label><label>所需工具<input value={draft.tools.join('、')} onChange={(event) => set({ tools: splitList(event.target.value) })} placeholder="read、search" /></label></div><label>Skill 正文<textarea className="expert-manager__skill-editor" rows={14} value={draft.content} onChange={(event) => set({ content: event.target.value })} placeholder="# 工作方法\n\n## 步骤\n" /></label><label className="expert-manager__switch"><input type="checkbox" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} /><span><strong>启用 Skill</strong><small>停用后，绑定它的专家不会注入这份工作方法</small></span></label><div className="expert-manager__form-actions"><button type="button" className="btn btn--sm" onClick={onCancel}>取消</button><button type="submit" className="btn btn--sm btn--primary" disabled={busy}><Save size={15} />保存 Skill</button></div></form>;
}

function splitList(value: string): string[] { return value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean); }
