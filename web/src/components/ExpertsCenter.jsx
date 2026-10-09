import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Copy, Gauge, Layers3, Link2, Pencil, Plus, RefreshCw, Save, Search, ShieldCheck, Sparkles, Trash2, Wrench, X } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { expertsApi } from '../api/experts.js';

const EMPTY_EXPERT = {
  id: '',
  name: '',
  description: '',
  icon: 'sparkles',
  enabled: true,
  systemPrompt: '',
  scope: { include: [], exclude: [] },
  skills: [],
  capabilities: { context: ['current-note', 'project', 'vault'], tools: ['read', 'search'], writePolicy: 'confirm', maxRounds: 6 },
  routing: { keywords: [], priority: 50, confidenceThreshold: 0.72 },
};

const EMPTY_SKILL = {
  id: '',
  name: '',
  description: '',
  version: '1.0.0',
  triggers: [],
  tools: ['read'],
  permissions: ['read'],
  enabled: true,
  content: '# 新 Skill\n\n## 工作流程\n\n描述 AI 应该如何完成这项工作。\n',
};

const CONTEXT_OPTIONS = [
  { id: 'current-note', label: '当前笔记', description: '正在编辑的内容' },
  { id: 'project', label: '当前项目', description: '项目文件与目录' },
  { id: 'vault', label: '知识库', description: '全局笔记与索引' },
];

const EXPERT_TOOL_OPTIONS = [
  { id: 'read', label: 'read', description: '读取文件内容' },
  { id: 'search', label: 'search', description: '知识库检索' },
  { id: 'write', label: 'write', description: '创建、编辑、移动等写入动作（需配合写入策略）' },
  { id: 'mcp', label: 'mcp', description: '调用已连接的 MCP Server 工具' },
];

const WRITE_POLICY_LABELS = {
  disabled: '只读',
  confirm: '写入需确认',
  auto: '任务模式自动写入',
};

function contextLabel(expert) {
  const context = expert.capabilities?.context ?? [];
  const labels = context.map((id) => CONTEXT_OPTIONS.find((item) => item.id === id)?.label ?? id).filter(Boolean);
  if (!labels.length) return '无上下文';
  return labels.length > 2 ? `${labels.slice(0, 2).join('、')} +${labels.length - 2}` : labels.join('、');
}

function writePolicyLabel(expert) {
  return WRITE_POLICY_LABELS[expert.capabilities?.writePolicy] ?? WRITE_POLICY_LABELS.confirm;
}

export default function ExpertsCenter({ open, initialTab = 'experts', onClose, onOpenConnections, experts, skills, activeExpertId, onSelectExpert, onChanged, onConfirmFileOperation, vaultDir }) {
  const [tab, setTab] = useState(initialTab);
  const [expertDraft, setExpertDraft] = useState(null);
  const [skillDraft, setSkillDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const isWorkspaceFilter = category === EXPERT_CATEGORIES[4];

  useEffect(() => {
    if (!open) return;
    setTab(initialTab === 'skills' || initialTab === 'connectors' ? initialTab : 'experts');
    setExpertDraft(null);
    setSkillDraft(null);
    setNotice('');
    setQuery('');
    setCategory('全部');
  }, [initialTab, open]);

  const visibleExperts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return experts.filter((expert) => {
      if (category !== '全部' && expertCategory(expert) !== category) return false;
      if (!normalized) return true;
      const haystack = [expert.name, expert.description, ...(expert.scope?.include ?? []), ...(expert.routing?.keywords ?? [])].join(' ').toLowerCase();
      return haystack.includes(normalized);
    });
  }, [category, experts, query]);

  const refresh = async () => {
    setBusy(true);
    try {
      await onChanged?.();
      setNotice('专家和 Skill 已刷新');
    } catch (error) {
      setNotice(error?.message ?? '刷新失败');
    } finally {
      setBusy(false);
    }
  };

  const saveExpert = async (event) => {
    event.preventDefault();
    if (!expertDraft?.id || !expertDraft.name.trim()) {
      setNotice('请填写专家 ID 和名称');
      return;
    }
    setBusy(true);
    try {
      const existing = experts.find((item) => item.id === expertDraft.id);
      const payload = toExpertPayload(expertDraft, !existing);
      const confirmation = await onConfirmFileOperation?.({
        vaultDir,
        actions: [{
          type: existing ? 'update' : 'create',
          path: `.lattice/experts/${expertDraft.id}.json`,
          contentSummary: `${existing ? '更新' : '创建'}专家配置「${expertDraft.name}」`,
        }],
        impact: '修改 1 个 .lattice 专家配置文件，影响后续 AI 路由与权限策略',
      });
      if (!confirmation?.confirmed) return;
      const request = { ...payload, ...confirmation };
      if (existing) await expertsApi.update(existing.id, request);
      else await expertsApi.create(request);
      await onChanged?.();
      setExpertDraft(null);
      setNotice('专家已保存');
    } catch (error) {
      setNotice(error?.message ?? '专家保存失败');
    } finally {
      setBusy(false);
    }
  };

  const saveSkill = async (event) => {
    event.preventDefault();
    if (!skillDraft?.id || !skillDraft.name.trim() || !skillDraft.content.trim()) {
      setNotice('请填写 Skill ID、名称和内容');
      return;
    }
    setBusy(true);
    try {
      const existing = skills.find((item) => item.id === skillDraft.id);
      const payload = toSkillPayload(skillDraft, !existing);
      const confirmation = await onConfirmFileOperation?.({
        vaultDir,
        actions: [
          { type: existing ? 'update' : 'create', path: `.lattice/skills/${skillDraft.id}/skill.json`, contentSummary: `${existing ? '更新' : '创建'} Skill 清单` },
          { type: existing ? 'update' : 'create', path: `.lattice/skills/${skillDraft.id}/SKILL.md`, contentSummary: `写入 Skill「${skillDraft.name}」正文` },
        ],
        impact: '修改 2 个 .lattice Skill 文件，影响 AI 工具与提示词行为',
      });
      if (!confirmation?.confirmed) return;
      const request = { ...payload, ...confirmation };
      if (existing) await expertsApi.updateSkill(existing.id, request);
      else await expertsApi.createSkill(request);
      await onChanged?.();
      setSkillDraft(null);
      setNotice('Skill 已保存');
    } catch (error) {
      setNotice(error?.message ?? 'Skill 保存失败');
    } finally {
      setBusy(false);
    }
  };

  const removeExpert = async (expert) => {
    setBusy(true);
    try {
      const confirmation = await onConfirmFileOperation?.({
        vaultDir,
        type: 'delete',
        path: `.lattice/experts/${expert.id}.json`,
        contentSummary: `删除工作区专家「${expert.name}」配置`,
        impact: '移除 1 个专家配置；内置专家本体不受影响',
        requiresSecondConfirmation: true,
      });
      if (!confirmation?.confirmed) return;
      await expertsApi.remove(expert.id, { body: confirmation });
      await onChanged?.();
      if (expert.id === activeExpertId) onSelectExpert('general');
      setNotice('专家已删除');
    } catch (error) {
      setNotice(error?.message ?? '专家删除失败');
    } finally {
      setBusy(false);
    }
  };

  const removeSkill = async (skill) => {
    setBusy(true);
    try {
      const confirmation = await onConfirmFileOperation?.({
        vaultDir,
        type: 'delete',
        path: `.lattice/skills/${skill.id}/`,
        contentSummary: `删除工作区 Skill「${skill.name}」及其清单、正文`,
        impact: '递归删除 1 个 Skill 目录及其中的配置文件',
        requiresSecondConfirmation: true,
      });
      if (!confirmation?.confirmed) return;
      await expertsApi.removeSkill(skill.id, { body: confirmation });
      await onChanged?.();
      setNotice('Skill 已删除');
    } catch (error) {
      setNotice(error?.message ?? 'Skill 删除失败');
    } finally {
      setBusy(false);
    }
  };

  const editSkill = async (skill) => {
    setBusy(true);
    try {
      const detail = await expertsApi.getSkill(skill.id);
      setSkillDraft(detail);
      setNotice('');
    } catch (error) {
      setNotice(error?.message ?? 'Skill 详情加载失败');
    } finally {
      setBusy(false);
    }
  };

  const copyExpert = (expert) => setExpertDraft({
    ...expert,
    id: `${expert.id}-custom`,
    name: `${expert.name} 副本`,
    source: undefined,
    skills: expert.skills.map((binding) => ({ id: binding.id, enabled: binding.enabled !== false, priority: binding.priority ?? 50, config: binding.config ?? {} })),
  });

  const copySkill = (skill) => setSkillDraft({ ...skill, id: `${skill.id}-custom`, name: `${skill.name} 副本`, source: undefined, filePath: undefined });

  const switchTab = (nextTab) => {
    setTab(nextTab);
    setExpertDraft(null);
    setSkillDraft(null);
  };

  return (
    <Modal open={open} onClose={onClose} title="专家中心" ariaLabel="专家中心" className="experts-center-modal">
      <div className="experts-center">
        <header className="experts-center__header">
          <nav className="experts-center__tabs" aria-label="专家中心视图">
            <button type="button" className={tab === 'experts' ? 'is-active' : ''} onClick={() => switchTab('experts')}><Sparkles size={16} />专家</button>
            <button type="button" className={tab === 'skills' ? 'is-active' : ''} onClick={() => switchTab('skills')}><Wrench size={16} />技能<span>{skills.length}</span></button>
            <button type="button" className={tab === 'connectors' ? 'is-active' : ''} onClick={() => switchTab('connectors')}><Link2 size={16} />连接器</button>
          </nav>
          <div className="experts-center__header-actions">
            <label className="experts-center__search">
              <Search size={15} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === 'experts' ? '搜索专家' : tab === 'skills' ? '搜索技能' : '搜索连接器'} aria-label={tab === 'experts' ? '搜索专家' : tab === 'skills' ? '搜索技能' : '搜索连接器'} />
            </label>
            <button type="button" className="icon-btn experts-center__close" onClick={onClose} aria-label="关闭专家中心" title="关闭"><X size={18} /></button>
          </div>
        </header>

        {notice ? <div className="experts-center__notice" role="status">{notice}</div> : null}

        {tab === 'experts' ? (
          <div className="experts-center__page">
            <section className="experts-center__featured" aria-labelledby="featured-experts-title">
              <div className="experts-center__page-intro">
                <span className="settings-kicker">EXPERT WORKSPACE</span>
                <h1 id="featured-experts-title">让每项工作都有合适的专家</h1>
                <p>专家会按自己的业务范围阅读对应 Skills，再用隔离的能力配置处理请求。</p>
              </div>
              <div className="experts-center__featured-list">
                {FEATURED_EXPERT_GROUPS.map((group) => <FeaturedExpert key={group.id} group={group} experts={experts} onSelectCategory={setCategory} />)}
              </div>
            </section>

            <section className="experts-center__catalog" aria-labelledby="expert-catalog-title">
              <div className="experts-center__section-head">
                <div><h2 id="expert-catalog-title">专家</h2><p>{isWorkspaceFilter ? '当前显示工作区中由你管理的专家。' : '选择一个专家开始一段隔离的 AI 会话。'}</p></div>
                <div className="experts-center__section-actions">
                  <div className="experts-center__catalog-stat"><span>{visibleExperts.length}</span><small>个专家</small></div>
                  <button type="button" className="icon-btn" onClick={refresh} disabled={busy} title="刷新专家" aria-label="刷新专家"><RefreshCw size={16} className={busy ? 'is-spinning' : undefined} /></button>
                  <button type="button" className="btn btn--sm btn--primary" onClick={() => setExpertDraft({ ...EMPTY_EXPERT, skills: [] })}><Plus size={15} />添加专家</button>
                </div>
              </div>
              <div className="experts-center__filters" role="toolbar" aria-label="专家筛选">
                {EXPERT_CATEGORIES.map((item) => <button type="button" key={item} className={category === item ? 'is-active' : ''} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}
              </div>
              <div className={`experts-center__catalog-body ${expertDraft ? 'has-editor' : ''}`}>
                <div className="experts-center__grid">
                  {visibleExperts.map((expert) => <ExpertMarketCard key={expert.id} expert={expert} active={expert.id === activeExpertId} onUse={() => { onSelectExpert(expert.id); onClose(); }} onEdit={() => setExpertDraft({ ...expert, skills: expert.skills.map((binding) => ({ id: binding.id, enabled: binding.enabled !== false, priority: binding.priority ?? 50, config: binding.config ?? {} })) })} onCopy={() => copyExpert(expert)} onRemove={() => removeExpert(expert)} />)}
                  {!visibleExperts.length ? <div className="experts-center__empty"><Search size={22} /><strong>没有匹配的专家</strong><span>换个关键词或清除筛选后再试。</span></div> : null}
                </div>
                {expertDraft ? <ExpertForm draft={expertDraft} skills={skills} busy={busy} onChange={setExpertDraft} onCancel={() => setExpertDraft(null)} onSubmit={saveExpert} /> : null}
              </div>
            </section>
          </div>
        ) : null}

        {tab === 'skills' ? (
          <div className="experts-center__page experts-center__skills-page">
            <section className="experts-center__catalog" aria-labelledby="skills-catalog-title">
              <div className="experts-center__section-head">
                <div><span className="settings-kicker">REUSABLE WORKFLOWS</span><h1 id="skills-catalog-title">技能</h1><p>Skill 是 AI 可以阅读、复用并绑定到多个专家的工作方法。</p></div>
                <div className="experts-center__section-actions"><button type="button" className="icon-btn" onClick={refresh} disabled={busy} title="刷新技能" aria-label="刷新技能"><RefreshCw size={16} className={busy ? 'is-spinning' : undefined} /></button><button type="button" className="btn btn--sm btn--primary" onClick={() => setSkillDraft({ ...EMPTY_SKILL })}><Plus size={15} />添加技能</button></div>
              </div>
              <div className="experts-center__catalog-body has-editor">
                <div className="experts-center__grid">
                  {skills.filter((skill) => !query.trim() || `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase())).map((skill) => <SkillMarketCard key={skill.id} skill={skill} onEdit={() => editSkill(skill)} onCopy={() => copySkill(skill)} onRemove={() => removeSkill(skill)} />)}
                </div>
                {skillDraft ? <SkillForm draft={skillDraft} busy={busy} onChange={setSkillDraft} onCancel={() => setSkillDraft(null)} onSubmit={saveSkill} /> : <div className="experts-center__empty"><BookOpen size={22} /><strong>选择一个技能开始编辑</strong><span>也可以新增一份 Markdown Skill，再绑定到多个专家。</span></div>}
              </div>
            </section>
          </div>
        ) : null}

        {tab === 'connectors' ? <ConnectorDirectory query={query} onOpenConnections={() => { onClose(); onOpenConnections?.(); }} /> : null}
      </div>
    </Modal>
  );
}

const EXPERT_CATEGORIES = ['全部', '知识研究', '工作流整理', '通用助手', '我的专家'];

const FEATURED_EXPERT_GROUPS = [
  { id: 'research', category: '知识研究', title: '知识研究', description: '检索、分析与引用整理', icon: BookOpen, tone: 'lavender' },
  { id: 'workflow', category: '工作流整理', title: '工作流整理', description: '把重复工作变成可靠流程', icon: Wrench, tone: 'sage' },
  { id: 'assistant', category: '通用助手', title: '通用助手', description: '覆盖日常知识库任务', icon: Sparkles, tone: 'sky' },
];

function expertCategory(expert) {
  if (expert.source === 'workspace') return '我的专家';
  const text = [expert.id, expert.name, expert.description, ...(expert.scope?.include ?? [])].join(' ').toLowerCase();
  if (text.includes('inbox') || text.includes('整理') || text.includes('归档') || text.includes('workflow')) return '工作流整理';
  if (text.includes('research') || text.includes('researcher') || text.includes('研究') || text.includes('检索') || text.includes('引用')) return '知识研究';
  return '通用助手';
}

function expertIcon(expert) {
  if (expert.icon === 'search' || expertCategory(expert) === '知识研究') return Search;
  if (expert.icon === 'inbox' || expertCategory(expert) === '工作流整理') return Wrench;
  return Sparkles;
}

function FeaturedExpert({ group, experts, onSelectCategory }) {
  const Icon = group.icon;
  const matches = experts.filter((expert) => expertCategory(expert) === group.category).slice(0, 3);
  return (
    <button type="button" className={`expert-feature expert-feature--${group.tone}`} onClick={() => onSelectCategory(group.category)}>
      <span className="expert-feature__art" aria-hidden="true"><span className="expert-feature__art-icon"><Icon size={28} /></span><span className="expert-feature__art-line" /></span>
      <span className="expert-feature__content"><strong>{group.title}</strong><small>{group.description}</small></span>
      <span className="expert-feature__experts">{matches.length ? matches.map((expert) => <span key={expert.id}>{expert.name}<b aria-hidden="true">›</b></span>) : <span>等待添加专家 <b aria-hidden="true">›</b></span>}</span>
    </button>
  );
}

function ExpertMarketCard({ expert, active, onUse, onEdit, onCopy, onRemove }) {
  const Icon = expertIcon(expert);
  const disabled = expert.enabled === false;
  const tags = (expert.scope?.include?.length ? expert.scope.include : expert.routing?.keywords ?? []).slice(0, 3);
  const missingCount = (expert.skills ?? []).filter((binding) => binding.enabled !== false && binding.available === false).length;
  return (
    <article className={`expert-market-card ${active ? 'is-active' : ''}${missingCount ? ' has-missing-skill' : ''}${disabled ? ' is-disabled' : ''}`}>
      <button type="button" className="expert-market-card__main" onClick={disabled ? onEdit : onUse} title={disabled ? '该专家已停用，点击编辑以重新启用' : undefined}>
        <span className="expert-market-card__avatar" aria-hidden="true"><Icon size={24} /></span>
        <span className="expert-market-card__identity"><span className="expert-market-card__title"><strong>{expert.name}</strong>{active ? <em className="is-current">当前</em> : null}{disabled ? <em className="is-off">已停用</em> : null}{expert.source === 'workspace' ? <em>我的</em> : null}</span><span className="expert-market-card__description">{expert.description || '暂无业务说明'}</span></span>
      </button>
      <div className="expert-market-card__tags">{tags.length ? tags.map((tag) => <span key={tag}>{tag}</span>) : <span>暂无标签</span>}</div>
      <div className="expert-market-card__capabilities" aria-label="专家能力摘要">
        <span><Layers3 size={13} aria-hidden="true" />{contextLabel(expert)}</span>
        <span><ShieldCheck size={13} aria-hidden="true" />{writePolicyLabel(expert)}</span>
      </div>
      <div className="expert-market-card__footer"><span className="expert-market-card__meta"><Sparkles size={14} />{expert.skillCount ?? expert.skills?.length ?? 0} 个 Skill{missingCount ? <button type="button" className="expert-market-card__missing" onClick={onEdit} title="查看缺失的 Skill 绑定">{missingCount} 个缺失</button> : null}</span><div className="expert-market-card__actions"><button type="button" className="expert-market-card__use" onClick={disabled ? onEdit : onUse} title={disabled ? '已停用，点击编辑以重新启用' : undefined}>{disabled ? '已停用' : active ? '当前使用' : '使用'}</button><button type="button" className="icon-btn" onClick={onEdit} title="编辑专家" aria-label={`编辑${expert.name}`}><Pencil size={14} /></button><button type="button" className="icon-btn" onClick={onCopy} title="复制专家" aria-label={`复制${expert.name}`}><Copy size={14} /></button><button type="button" className="icon-btn icon-btn--danger" onClick={onRemove} disabled={expert.source !== 'workspace'} title={expert.source === 'workspace' ? '删除专家' : '内置专家不可删除'} aria-label={`删除${expert.name}`}><Trash2 size={14} /></button></div></div>
    </article>
  );
}

function SkillMarketCard({ skill, onEdit, onCopy, onRemove }) {
  const tags = (skill.triggers?.length ? skill.triggers : skill.permissions ?? []).slice(0, 3);
  const disabled = skill.enabled === false;
  return (
    <article className={`expert-market-card skill-market-card${disabled ? ' is-disabled' : ''}`}>
      <button type="button" className="expert-market-card__main" onClick={onEdit}>
        <span className="expert-market-card__avatar" aria-hidden="true"><BookOpen size={24} /></span>
        <span className="expert-market-card__identity"><span className="expert-market-card__title"><strong>{skill.name}</strong>{disabled ? <em className="is-off">已停用</em> : null}{skill.source === 'workspace' ? <em>我的</em> : null}</span><span className="expert-market-card__description">{skill.description || '可复用的 AI 工作方法'}</span></span>
      </button>
      <div className="expert-market-card__tags">{tags.length ? tags.map((tag) => <span key={tag}>{tag}</span>) : <span>暂无触发词</span>}</div>
      <div className="expert-market-card__footer"><span className="expert-market-card__meta"><Wrench size={14} />{skill.tools?.length ?? 0} 个工具</span><div className="expert-market-card__actions"><button type="button" className="expert-market-card__use" onClick={onEdit}>编辑</button><button type="button" className="icon-btn" onClick={onCopy} title="复制 Skill" aria-label={`复制${skill.name}`}><Copy size={14} /></button><button type="button" className="icon-btn icon-btn--danger" onClick={onRemove} disabled={skill.source !== 'workspace'} title={skill.source === 'workspace' ? '删除 Skill' : '内置 Skill 不可删除'} aria-label={`删除${skill.name}`}><Trash2 size={14} /></button></div></div>
    </article>
  );
}

function ConnectorDirectory({ query, onOpenConnections }) {
  const connectors = [
    { id: 'mcp', title: 'MCP Server', description: '连接文件、联网、记忆和开发辅助工具。', icon: Link2, tags: ['外部工具', '可配置'] },
    { id: 'vault', title: '知识库上下文', description: '让专家读取当前笔记、项目和知识库内容。', icon: BookOpen, tags: ['当前工作区', '只读上下文'] },
    { id: 'actions', title: '操作权限', description: '按专家配置控制创建、移动、归档等写入动作。', icon: Sparkles, tags: ['确认机制', '按专家隔离'] },
  ];
  const visible = connectors.filter((item) => !query.trim() || `${item.title} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="experts-center__page experts-center__connectors-page">
      <section className="connector-directory" aria-labelledby="connector-directory-title">
        <div className="connector-directory__intro"><span className="settings-kicker">CONNECTED CAPABILITIES</span><h1 id="connector-directory-title">连接器</h1><p>把外部工具接入专家的工作范围，由 MCP 设置统一管理连接和权限。</p><button type="button" className="btn btn--sm btn--primary" onClick={onOpenConnections}><Link2 size={15} />打开 MCP 设置</button></div>
        <div className="connector-directory__grid">{visible.map((item) => { const Icon = item.icon; return <article key={item.id} className="connector-directory__card"><span className="connector-directory__icon"><Icon size={22} /></span><h2>{item.title}</h2><p>{item.description}</p><div>{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></article>; })}</div>
      </section>
    </div>
  );
}

function toExpertPayload(draft, includeId) {
  const payload = {
    version: draft.version,
    name: draft.name.trim(),
    description: draft.description.trim(),
    icon: draft.icon,
    enabled: draft.enabled !== false,
    systemPrompt: draft.systemPrompt ?? '',
    scope: draft.scope ?? { include: [], exclude: [] },
    skills: (draft.skills ?? []).map((binding) => ({
      id: binding.id,
      enabled: binding.enabled !== false,
      priority: binding.priority ?? 50,
      config: binding.config ?? {},
    })),
    capabilities: draft.capabilities,
    routing: draft.routing,
  };
  return includeId ? { id: draft.id, ...payload } : payload;
}

function toSkillPayload(draft, includeId) {
  const payload = {
    version: draft.version,
    name: draft.name.trim(),
    description: draft.description.trim(),
    triggers: draft.triggers ?? [],
    tools: draft.tools ?? [],
    permissions: draft.permissions ?? ['read'],
    inputSchema: draft.inputSchema ?? { type: 'object' },
    outputSchema: draft.outputSchema ?? { type: 'object' },
    enabled: draft.enabled !== false,
    content: draft.content.trim(),
  };
  return includeId ? { id: draft.id, ...payload } : payload;
}

function ExpertForm({ draft, skills, busy, onChange, onCancel, onSubmit }) {
  const set = (patch) => onChange((current) => ({ ...current, ...patch }));
  const setScope = (key, value) => set({ scope: { ...draft.scope, [key]: splitList(value) } });
  const setCapabilities = (patch) => set({ capabilities: { context: ['current-note', 'project', 'vault'], tools: ['read', 'search'], writePolicy: 'confirm', maxRounds: 6, ...draft.capabilities, ...patch } });
  const setRouting = (patch) => set({ routing: { keywords: [], priority: 50, confidenceThreshold: 0.72, ...draft.routing, ...patch } });
  const toggleContext = (id, checked) => {
    const context = draft.capabilities?.context ?? [];
    setCapabilities({ context: checked ? [...new Set([...context, id])] : context.filter((item) => item !== id) });
  };
  const toggleTool = (id, checked) => {
    const tools = draft.capabilities?.tools ?? [];
    setCapabilities({ tools: checked ? [...new Set([...tools, id])] : tools.filter((item) => item !== id) });
  };
  const bindableSkills = skills.filter((skill) => skill.enabled !== false);
  const missingBindings = (draft.skills ?? []).filter((binding) => !skills.some((skill) => skill.id === binding.id));
  const disabledBindings = (draft.skills ?? []).filter((binding) => skills.some((skill) => skill.id === binding.id && skill.enabled === false));
  const unbind = (id) => set({ skills: (draft.skills ?? []).filter((item) => item.id !== id) });
  return (
    <form className="experts-center__form" onSubmit={onSubmit}>
      <div className="experts-center__form-head"><div><span className="settings-kicker">EXPERT PROFILE</span><h3>{draft.name ? '编辑专家' : '添加专家'}</h3></div><button type="button" className="icon-btn" onClick={onCancel} aria-label="取消" title="取消"><X size={16} /></button></div>
      <section className="experts-center__form-section">
        <div className="experts-center__form-section-head"><div><strong>身份信息</strong><small>先让专家在目录里容易被识别。</small></div></div>
        <div className="experts-center__form-grid"><label>名称<input value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="例如：Inbox 整理专家" /></label><label>ID<input value={draft.id} disabled={Boolean(draft.source)} onChange={(event) => set({ id: event.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-') })} placeholder="例如：inbox-organizer" /></label></div>
        <label>说明<input value={draft.description} onChange={(event) => set({ description: event.target.value })} placeholder="这个专家主要处理什么" /></label>
        <label className="experts-center__check"><input type="checkbox" checked={draft.enabled !== false} onChange={(event) => set({ enabled: event.target.checked })} /><span><strong>启用该专家</strong><small>停用后不出现在专家选择器，也不再参与路由建议</small></span></label>
      </section>
      <section className="experts-center__form-section">
        <div className="experts-center__form-section-head"><div><strong>工作方式</strong><small>定义判断原则，以及它应该主动关注的范围。</small></div></div>
        <label>专家指令<textarea rows="4" value={draft.systemPrompt} onChange={(event) => set({ systemPrompt: event.target.value })} placeholder="告诉 AI 该专家的判断原则和工作方式" /></label>
        <div className="experts-center__form-grid"><label>处理范围<input value={(draft.scope?.include ?? []).join('、')} onChange={(event) => setScope('include', event.target.value)} placeholder="整理、分类、归档" /></label><label>不处理<input value={(draft.scope?.exclude ?? []).join('、')} onChange={(event) => setScope('exclude', event.target.value)} placeholder="系统设置、外部发布" /></label></div>
      </section>
      <section className="experts-center__form-section">
        <div className="experts-center__form-section-head"><div><strong><Gauge size={14} aria-hidden="true" />运行边界</strong><small>把上下文和写入权限控制在你预期的范围内。</small></div></div>
        <div className="experts-center__form-grid"><label>写入策略<select value={draft.capabilities?.writePolicy ?? 'confirm'} onChange={(event) => setCapabilities({ writePolicy: event.target.value })}><option value="disabled">禁止写入</option><option value="confirm">写入前确认</option><option value="auto">允许任务模式自动写入</option></select></label><label>最大回合数<input type="number" min="1" max="12" value={draft.capabilities?.maxRounds ?? 6} onChange={(event) => setCapabilities({ maxRounds: Math.max(1, Math.min(12, Number(event.target.value) || 1)) })} /></label></div>
        <fieldset className="experts-center__form-fieldset"><legend>可读取范围</legend><div className="experts-center__context-grid">{CONTEXT_OPTIONS.map((option) => <label key={option.id} className="experts-center__check experts-center__context-check"><input type="checkbox" checked={(draft.capabilities?.context ?? []).includes(option.id)} onChange={(event) => toggleContext(option.id, event.target.checked)} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}</div></fieldset>
        <fieldset className="experts-center__form-fieldset"><legend>能力工具</legend><div className="experts-center__context-grid">{EXPERT_TOOL_OPTIONS.map((option) => <label key={option.id} className="experts-center__check experts-center__context-check"><input type="checkbox" checked={(draft.capabilities?.tools ?? []).includes(option.id)} onChange={(event) => toggleTool(option.id, event.target.checked)} /><span><strong><code>{option.label}</code></strong><small>{option.description}</small></span></label>)}</div><p className="experts-center__muted">未勾选的动作会被直接过滤，不会交给模型执行。</p></fieldset>
        <div className="experts-center__form-grid"><label>路由优先级<input type="number" min="0" max="100" value={draft.routing?.priority ?? 50} onChange={(event) => setRouting({ priority: Math.max(0, Math.min(100, Number(event.target.value) || 0)) })} /></label><label>路由关键词<input value={(draft.routing?.keywords ?? []).join('、')} onChange={(event) => setRouting({ keywords: splitList(event.target.value) })} placeholder="整理、归档、Inbox" /></label></div>
        <p className="experts-center__muted">使用通用专家对话时，消息命中至少 2 个路由关键词就会建议切换到该专家；优先级在多个专家同时命中时决胜。</p>
      </section>
      <section className="experts-center__form-section experts-center__form-section--last">
        <div className="experts-center__form-section-head"><div><strong>绑定 Skill</strong><small>把可复用的工作方法组合到这个专家中。</small></div></div>
        <fieldset className="experts-center__form-fieldset">{bindableSkills.length ? bindableSkills.map((skill) => { const checked = draft.skills?.some((item) => item.id === skill.id && item.enabled !== false); return <label key={skill.id} className="experts-center__check"><input type="checkbox" checked={checked} onChange={(event) => { const next = (draft.skills ?? []).filter((item) => item.id !== skill.id); if (event.target.checked) next.push({ id: skill.id, enabled: true, priority: 50, config: {} }); set({ skills: next }); }} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span></label>; }) : <p className="experts-center__muted">还没有可绑定的 Skill。</p>}
          {missingBindings.length ? <div className="experts-center__binding-issues">{missingBindings.map((binding) => (
            <div key={binding.id} className="experts-center__binding-issue is-missing"><span>缺失 Skill <code>{binding.id}</code>：绑定不会生效，请在「技能」页创建同名 Skill。</span><button type="button" className="btn btn--sm" onClick={() => unbind(binding.id)}>解除绑定</button></div>
          ))}</div> : null}
          {disabledBindings.length ? <div className="experts-center__binding-issues">{disabledBindings.map((binding) => (
            <div key={binding.id} className="experts-center__binding-issue is-disabled"><span>Skill <code>{binding.id}</code> 已停用：重新启用后才会注入该专家。</span><button type="button" className="btn btn--sm" onClick={() => unbind(binding.id)}>解除绑定</button></div>
          ))}</div> : null}
        </fieldset>
      </section>
      <div className="experts-center__form-actions"><button type="button" className="btn btn--sm" onClick={onCancel}>取消</button><button type="submit" className="btn btn--sm btn--primary" disabled={busy}><Save size={15} />保存专家</button></div>
    </form>
  );
}

function SkillForm({ draft, busy, onChange, onCancel, onSubmit }) {
  const set = (patch) => onChange((current) => ({ ...current, ...patch }));
  return (
    <form className="experts-center__form" onSubmit={onSubmit}>
      <div className="experts-center__form-head"><div><span className="settings-kicker">SKILL DEFINITION</span><h3>{draft.name ? '编辑 Skill' : '添加 Skill'}</h3></div><button type="button" className="icon-btn" onClick={onCancel} aria-label="取消" title="取消"><X size={16} /></button></div>
      <label>名称<input value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="例如：会议纪要整理" /></label>
      <label>ID<input value={draft.id} disabled={Boolean(draft.source)} onChange={(event) => set({ id: event.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-') })} placeholder="例如：meeting-summary" /></label>
      <label>说明<input value={draft.description} onChange={(event) => set({ description: event.target.value })} placeholder="这项 Skill 解决什么问题" /></label>
      <label className="experts-center__check"><input type="checkbox" checked={draft.enabled !== false} onChange={(event) => set({ enabled: event.target.checked })} /><span><strong>启用该 Skill</strong><small>停用后绑定它的专家不再注入这份工作方法</small></span></label>
      <label>触发词<input value={(draft.triggers ?? []).join('、')} onChange={(event) => set({ triggers: splitList(event.target.value) })} placeholder="会议纪要、提取行动项" /></label>
      <label>所需工具<input value={(draft.tools ?? []).join('、')} onChange={(event) => set({ tools: splitList(event.target.value) })} placeholder="read、search" /><small className="experts-center__muted">会写进专家提示词，提示 AI 这项 Skill 依赖哪些动作</small></label>
      <label>Skill 内容<textarea className="experts-center__skill-editor" rows="12" value={draft.content ?? ''} onChange={(event) => set({ content: event.target.value })} /></label>
      <div className="experts-center__form-actions"><button type="button" className="btn btn--sm" onClick={onCancel}>取消</button><button type="submit" className="btn btn--sm btn--primary" disabled={busy}><Save size={15} />保存 Skill</button></div>
    </form>
  );
}

function splitList(value) {
  return String(value ?? '').split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
}
