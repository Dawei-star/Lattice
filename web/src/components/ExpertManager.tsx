import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { BookOpen, Check, Copy, FileDown, Layers3, Link2, Plus, RefreshCw, Save, Search, Settings2, ShieldCheck, Sparkles, Trash2, Upload, Wrench, X } from 'lucide-react';
import Modal from '../ui/Modal.tsx';
import { expertsApi } from '../api/experts.ts';
import {
  CONTEXT_OPTIONS,
  EXPERT_MAX_ROUNDS,
  EXPERT_PROMPT_MAX_CHARS,
  SKILL_MODE_OPTIONS,
  TOOL_OPTIONS,
  WRITE_POLICY_OPTIONS,
  copyDraft,
  describeWritePolicy,
  draftFromExpert,
  emptyExpertDraft,
  expertFilePath,
  joinList,
  payloadFromDraft,
  skillDirectoryPath,
  splitList,
  toggleList,
  type ExpertDoc,
  type ExpertDraft,
  type ExpertSkillBinding,
  type SkillDoc,
  type SkillMode,
} from '../lib/expert-doc.ts';
import { McpToolsCenter } from '../settings/SettingsModal.tsx';
import type { FileConfirmationResult, FileOperationInput } from '../hooks/useFileConfirmation.tsx';

export type ManagerTab = 'experts' | 'skills' | 'mcp';

/** 技能草稿：对齐 Agent Skills 规范（name/description/license/compatibility/allowed-tools/metadata）。 */
interface SkillDraft {
  id: string;
  title: string;
  description: string;
  version: string;
  license: string;
  compatibility: string;
  allowedTools: string[];
  enabled: boolean;
  content: string;
  source?: string;
}

/** 导入来源：粘贴文本 / 本地 SKILL.md 或目录 / 远端链接。 */
type SkillImportSource = 'text' | 'path' | 'url';

interface ExpertManagerProps {
  open: boolean;
  initialTab?: ManagerTab;
  onClose: () => void;
  experts: ExpertDoc[];
  skills: SkillDoc[];
  activeExpertId: string;
  onSelectExpert: (expertId: string) => void;
  onChanged?: () => void | Promise<unknown>;
  onConfirmFileOperation?: (operation: FileOperationInput) => Promise<FileConfirmationResult>;
  vaultDir?: string;
}

const EMPTY_SKILL: SkillDraft = {
  id: '', title: '', description: '', version: '2.0.0',
  license: '', compatibility: '', allowedTools: [], enabled: true,
  content: '# 工作方法\n\n## 步骤\n\n1. \n',
};

const SKILL_IMPORT_PLACEHOLDER: Record<SkillImportSource, string> = {
  text: '把 SKILL.md 全文粘到这里（--- 包围的 frontmatter + 正文）',
  path: '本机 SKILL.md 路径，或技能目录（例如 D:/skills/pdf）',
  url: 'SKILL.md 链接（GitHub blob 页面或 raw 地址都可以）',
};

export default function ExpertManager({ open, initialTab = 'experts', onClose, experts, skills, activeExpertId, onSelectExpert, onChanged, onConfirmFileOperation, vaultDir }: ExpertManagerProps) {
  const [tab, setTab] = useState<ManagerTab>(initialTab);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [expertDraft, setExpertDraft] = useState<ExpertDraft | null>(null);
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importSource, setImportSource] = useState<SkillImportSource>('text');
  const [importValue, setImportValue] = useState('');
  const [expertImportOpen, setExpertImportOpen] = useState(false);
  const [expertImportValue, setExpertImportValue] = useState('');
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [claudeSkills, setClaudeSkills] = useState<Array<{ document: SkillDoc; markdown: string; installed: boolean }>>([]);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setQuery('');
    setExpertDraft(null);
    setSkillDraft(null);
    setNotice('');
    setExpertImportOpen(false);
    setExpertImportValue('');
    setClaudeOpen(false);
    setClaudeSkills([]);
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
    setExpertImportOpen(false);
    setClaudeOpen(false);
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
    setExpertDraft(emptyExpertDraft());
    setNotice('');
  };

  const newSkill = () => {
    setTab('skills');
    setSelectedId('');
    setSkillDraft({ ...EMPTY_SKILL });
    setNotice('');
  };

  /** 编辑：内置专家一律载入「副本」草稿（E1 起不再就地改内置，避免静默遮蔽）。 */
  const editExpert = (expert: ExpertDoc) => {
    const draft = draftFromExpert(expert);
    setSelectedId(expert.id);
    if (expert.source !== 'workspace') {
      setExpertDraft(copyDraft(draft));
      setNotice('内置专家不可直接修改：已载入副本，保存后成为你自己的版本');
      return;
    }
    setExpertDraft(draft);
    setNotice('');
  };

  const copyExpert = (expert: ExpertDoc) => {
    setSelectedId(expert.id);
    setExpertDraft(copyDraft(draftFromExpert(expert)));
    setNotice('已载入副本草稿，保存后成为你自己的版本');
  };

  /** 文档 → 草稿（缺失字段回落默认值，保证表单永远可编辑）。 */
  const skillDraftFrom = (skill: SkillDoc, overrides: Partial<SkillDraft> = {}): SkillDraft => ({
    ...EMPTY_SKILL,
    id: String(skill.id ?? ''),
    title: String(skill.title ?? skill.name ?? skill.id ?? ''),
    description: String(skill.description ?? ''),
    version: String(skill.version ?? '2.0.0'),
    license: String(skill.license ?? ''),
    compatibility: String(skill.compatibility ?? ''),
    allowedTools: Array.isArray(skill.allowedTools) ? skill.allowedTools.map(String) : [],
    enabled: skill.enabled !== false,
    content: String(skill.content ?? EMPTY_SKILL.content),
    source: typeof skill.source === 'string' ? skill.source : undefined,
    ...overrides,
  });

  /** 编辑：内置技能载入副本（与专家同规则，避免静默遮蔽）。 */
  const editSkill = async (skill: SkillDoc) => {
    setSelectedId(skill.id);
    setBusy(true);
    try {
      const detail = (await expertsApi.getSkill(skill.id)) as unknown as SkillDoc;
      if (detail.source !== 'workspace') {
        setSkillDraft(skillDraftFrom(detail, {
          id: `${detail.id}-custom`,
          title: `${String(detail.title ?? detail.name ?? detail.id)} 副本`,
          source: undefined,
        }));
        setNotice('内置 Skill 不可直接修改：已载入副本，保存后成为你自己的版本');
        return;
      }
      setSkillDraft(skillDraftFrom(detail));
      setNotice('');
    } catch (error) {
      setNotice((error as Error)?.message ?? 'Skill 详情加载失败');
    } finally {
      setBusy(false);
    }
  };

  const copySkill = (skill: SkillDoc) => {
    setSelectedId('');
    setSkillDraft(skillDraftFrom(skill, {
      id: `${skill.id}-custom`,
      title: `${String(skill.title ?? skill.name ?? skill.id)} 副本`,
      source: undefined,
    }));
  };

  /** E4：专家导出为 .md（frontmatter + 正文），复制到剪贴板。 */
  const exportExpert = async (expert: ExpertDoc) => {
    setBusy(true);
    try {
      const data = await expertsApi.exportExpert(expert.id);
      const copied = await copyToClipboard(String(data.markdown ?? ''));
      setNotice(copied ? `已复制 ${data.filename ?? '专家.md'}` : '浏览器不允许写剪贴板，请手动复制');
    } catch (error) {
      setNotice((error as Error)?.message ?? '导出失败');
    } finally {
      setBusy(false);
    }
  };

  /** E4：LobeChat 角色卡 → 专家草稿（不落盘）。 */
  const importExpertCard = async () => {
    if (!expertImportValue.trim()) {
      setNotice('请粘贴 LobeChat 角色卡 JSON');
      return;
    }
    setBusy(true);
    try {
      const preview = await expertsApi.importExpertCard(expertImportValue);
      if (!preview.document) throw new Error('角色卡没有解析出专家');
      setExpertDraft(draftFromExpert(preview.document as unknown as ExpertDoc));
      setSelectedId('');
      setExpertImportOpen(false);
      setExpertImportValue('');
      setNotice('已解析为草稿：检查提示词与能力后点「保存专家」');
    } catch (error) {
      setNotice((error as Error)?.message ?? '角色卡导入失败');
    } finally {
      setBusy(false);
    }
  };

  /** E4：只读扫描 ~/.claude/skills，列出可导入候选。 */
  const discoverClaude = async () => {
    setBusy(true);
    try {
      const list = await expertsApi.discoverClaudeSkills();
      setClaudeSkills(list);
      setClaudeOpen(true);
      setSkillDraft(null);
      setSelectedId('');
      setNotice(list.length ? `发现 ${list.length} 个 Claude 技能` : '~/.claude/skills 下没有可导入的技能');
    } catch (error) {
      setNotice((error as Error)?.message ?? 'Claude 技能发现失败');
    } finally {
      setBusy(false);
    }
  };

  const useClaudeSkill = (document: SkillDoc) => {
    setSkillDraft(skillDraftFrom(document, { source: undefined }));
    setClaudeOpen(false);
    setNotice('已载入草稿：确认后点「保存 Skill」写入知识库');
  };

  /** 导入：先解析成草稿（不落盘），保存仍走确认流程。 */
  const importSkill = async () => {
    if (!importValue.trim()) {
      setNotice('请粘贴 SKILL.md，或填写路径 / 链接');
      return;
    }
    setBusy(true);
    try {
      const preview = (await expertsApi.importSkill({ source: importSource, value: importValue })) as { document?: SkillDoc };
      const document = preview.document;
      if (!document) throw new Error('导入内容没有解析出技能');
      const draft = skillDraftFrom(document, { source: undefined });
      if (!draft.title.trim()) draft.title = draft.id;
      setSkillDraft(draft);
      setSelectedId('');
      setImportOpen(false);
      setImportValue('');
      setNotice('已解析为草稿：检查 frontmatter 与正文后点「保存 Skill」写入知识库');
    } catch (error) {
      setNotice((error as Error)?.message ?? '导入失败');
    } finally {
      setBusy(false);
    }
  };

  /** 导出：复制规范化后的 SKILL.md 全文（含 references 清单提示）。 */
  const exportSkill = async (skill: SkillDoc) => {
    setBusy(true);
    try {
      const data = (await expertsApi.exportSkill(skill.id)) as { markdown?: string; references?: string[]; filename?: string };
      const copied = await copyToClipboard(String(data.markdown ?? ''));
      const references = Array.isArray(data.references) ? data.references : [];
      setNotice(copied
        ? `已复制 ${data.filename ?? 'SKILL.md'}${references.length ? `；references/ 另有 ${references.length} 个文件，需一并带走` : ''}`
        : '浏览器不允许写剪贴板，请手动从编辑区复制');
    } catch (error) {
      setNotice((error as Error)?.message ?? '导出失败');
    } finally {
      setBusy(false);
    }
  };

  const saveExpert = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!expertDraft?.id.trim() || !expertDraft.name.trim()) { setNotice('请填写专家 ID 和名称'); return; }
    const payload = payloadFromDraft(expertDraft);
    const existing = experts.find((item) => item.id === payload.id);
    setBusy(true);
    try {
      const confirmation = await onConfirmFileOperation?.({
        vaultDir,
        actions: [{
          type: existing ? 'update' : 'create',
          path: expertFilePath(String(payload.id)),
          contentSummary: `${existing ? '更新' : '创建'}专家「${payload.name}」`,
        }],
        impact: '写入 1 个 .lattice 专家文件（Markdown，正文即提示词），影响 AI 人格、工具面与写入策略',
      });
      if (!confirmation?.confirmed) return;
      if (existing) await expertsApi.update(String(payload.id), { ...payload, ...confirmation });
      else await expertsApi.create({ ...payload, ...confirmation });
      await onChanged?.();
      setSelectedId(String(payload.id));
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
    if (!skillDraft) return;
    const id = skillDraft.id.trim();
    const title = skillDraft.title.trim() || id;
    const content = skillDraft.content.trim();
    if (!id || !content) { setNotice('请填写 Skill ID 与正文'); return; }
    setBusy(true);
    try {
      const existing = skills.find((item) => item.id === id && item.source === 'workspace');
      const payload = {
        id,
        title,
        description: skillDraft.description.trim(),
        version: skillDraft.version.trim() || '2.0.0',
        license: skillDraft.license.trim() || undefined,
        compatibility: skillDraft.compatibility.trim() || undefined,
        allowedTools: skillDraft.allowedTools,
        enabled: skillDraft.enabled,
        content,
      };
      const confirmation = await onConfirmFileOperation?.({
        vaultDir,
        actions: [{
          type: existing ? 'update' : 'create',
          path: `${skillDirectoryPath(id)}SKILL.md`,
          contentSummary: `${existing ? '更新' : '创建'} Skill「${title}」`,
        }],
        impact: '写入 1 个 .lattice/skills/<id>/SKILL.md（frontmatter 存元数据、正文存方法）',
      });
      if (!confirmation?.confirmed) return;
      if (existing) await expertsApi.updateSkill(existing.id, { ...payload, ...confirmation });
      else await expertsApi.createSkill({ ...payload, ...confirmation });
      await onChanged?.();
      setSelectedId(id);
      setSkillDraft(null);
      setNotice('Skill 已保存（单文件 SKILL.md）');
    } catch (error) {
      setNotice((error as Error)?.message ?? 'Skill 保存失败');
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (item: ExpertDoc | SkillDoc, kind: ManagerTab) => {
    if (item.source !== 'workspace') return;
    setBusy(true);
    try {
      const isExpert = kind === 'experts';
      const confirmation = await onConfirmFileOperation?.({
        vaultDir,
        type: 'delete',
        path: isExpert ? expertFilePath(item.id) : skillDirectoryPath(item.id),
        contentSummary: `删除${isExpert ? '专家' : 'Skill'}「${item.name ?? item.id}」`,
        impact: isExpert ? '移除 1 个专家文件（.lattice/experts）' : '递归删除 1 个 Skill 目录及其中的配置文件',
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
        <CapabilityMap tab={tab} />
        <div className={`expert-manager__body${tab === 'mcp' ? ' is-mcp' : ''}`}>
          {tab !== 'mcp' ? <aside className="expert-manager__list-pane">
            <div className="expert-manager__list-head">
              <div><strong>{tab === 'experts' ? '专家目录' : 'Skill 目录'}</strong><small>{tab === 'experts' ? '选择后在右侧配置' : '可复用的工作方法'}</small></div>
              <div className="expert-manager__list-actions">
                {tab === 'experts' ? <button type="button" className="icon-btn" onClick={() => { setExpertImportOpen(true); setExpertDraft(null); setSelectedId(''); setNotice(''); }} aria-label="导入角色卡" title="导入 LobeChat 角色卡"><Upload size={16} /></button> : null}
                {tab === 'skills' ? <button type="button" className="icon-btn" onClick={() => void discoverClaude()} disabled={busy} aria-label="从 ~/.claude/skills 导入" title="从 ~/.claude/skills 导入"><FileDown size={16} /></button> : null}
                {tab === 'skills' ? <button type="button" className="icon-btn" onClick={() => { setImportOpen(true); setSkillDraft(null); setSelectedId(''); setNotice(''); }} aria-label="导入 SKILL.md" title="导入 SKILL.md"><Upload size={16} /></button> : null}
                <button type="button" className="icon-btn" onClick={tab === 'experts' ? newExpert : newSkill} aria-label={tab === 'experts' ? '添加专家' : '添加 Skill'} title={tab === 'experts' ? '添加专家' : '添加 Skill'}><Plus size={16} /></button>
              </div>
            </div>
            <label className="expert-manager__search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === 'experts' ? '搜索专家' : '搜索 Skill'} aria-label={tab === 'experts' ? '搜索专家' : '搜索 Skill'} /></label>
            <div className="expert-manager__items" role="listbox" aria-label={tab === 'experts' ? '专家列表' : 'Skill 列表'}>{filteredItems.map((item) => <button type="button" role="option" aria-selected={selectedId === item.id} className={`expert-manager__item ${selectedId === item.id ? 'is-selected' : ''}`} key={item.id} onClick={() => { setSelectedId(item.id); setExpertDraft(null); setSkillDraft(null); setNotice(''); }}>{tab === 'experts' ? <Sparkles size={15} /> : <BookOpen size={15} />}<span><strong>{tab === 'experts' ? (item.name || item.id) : String((item as SkillDoc).title ?? item.name ?? item.id)}</strong><small>{item.description || '未填写说明'}</small></span>{item.source === 'workspace' ? <em>我的</em> : null}</button>)}{!filteredItems.length ? <div className="expert-manager__list-empty">没有匹配项</div> : null}</div>
          </aside> : null}
          <section className="expert-manager__detail" aria-label={tab === 'experts' ? '专家配置' : tab === 'skills' ? 'Skill 配置' : 'MCP 工具中心'}>
            {notice ? <div className="expert-manager__notice" role="status">{notice}</div> : null}
            {tab === 'mcp' ? <div className="expert-manager__mcp"><McpToolsCenter vaultPath={vaultDir ?? ''} /></div> : tab === 'experts' ? (expertImportOpen ? <ExpertCardImportPanel value={expertImportValue} busy={busy} onValue={setExpertImportValue} onSubmit={() => void importExpertCard()} onCancel={() => { setExpertImportOpen(false); setExpertImportValue(''); }} /> : expertDraft ? <ExpertForm draft={expertDraft} skills={skills} busy={busy} onChange={setExpertDraft} onCancel={() => { setExpertDraft(null); setNotice(''); }} onSubmit={saveExpert} /> : selectedExpert ? <ExpertSummary expert={selectedExpert} active={selectedExpert.id === activeExpertId} onUse={() => { onSelectExpert(selectedExpert.id); onClose(); }} onEdit={() => editExpert(selectedExpert)} onCopy={() => copyExpert(selectedExpert)} onExport={() => void exportExpert(selectedExpert)} onRemove={() => void removeItem(selectedExpert, 'experts')} /> : <ManagerEmpty kind="experts" onCreate={newExpert} />) : (claudeOpen ? <ClaudeSkillsPanel items={claudeSkills} onUse={useClaudeSkill} onClose={() => setClaudeOpen(false)} /> : importOpen ? <SkillImportPanel source={importSource} value={importValue} busy={busy} onSource={setImportSource} onValue={setImportValue} onSubmit={() => void importSkill()} onCancel={() => { setImportOpen(false); setImportValue(''); }} /> : skillDraft ? <SkillForm draft={skillDraft} busy={busy} onChange={setSkillDraft} onCancel={() => setSkillDraft(null)} onSubmit={saveSkill} /> : selectedSkill ? <SkillSummary skill={selectedSkill} onEdit={() => void editSkill(selectedSkill)} onCopy={() => copySkill(selectedSkill)} onExport={() => void exportSkill(selectedSkill)} onRemove={() => void removeItem(selectedSkill, 'skills')} /> : <ManagerEmpty kind="skills" onCreate={newSkill} />)}
          </section>
        </div>
      </div>
    </Modal>
  );
}

/** 能力地图：一屏讲清「专家 / Skill / MCP」的分工（Cherry 的概念混淆抱怨是这类产品的头号坑）。 */
function CapabilityMap({ tab }: { tab: ManagerTab }) {
  const cards = [
    { id: 'experts' as ManagerTab, icon: <Sparkles size={15} />, title: '专家', body: '人格 + 能力绑定的入口：走哪种工作方式、能碰哪些工具、写不写、几轮停。', hint: '想换工作方式 / 工具面' },
    { id: 'skills' as ManagerTab, icon: <Wrench size={15} />, title: 'Skill', body: '给模型的知识与方法包（SKILL.md）：具体怎么判断、按什么步骤做。', hint: '想让 AI 更懂某个领域' },
    { id: 'mcp' as ManagerTab, icon: <Link2 size={15} />, title: 'MCP', body: '外来手脚：把外部系统的工具接进同一个工具面（日历、检索、业务系统）。', hint: '想接外部系统' },
  ];
  return (
    <div className="expert-manager__map" aria-label="能力地图">
      {cards.map((card) => <div key={card.id} className={`expert-manager__map-card ${tab === card.id ? 'is-active' : ''}`}><span className="expert-manager__map-icon">{card.icon}</span><div><strong>{card.title}</strong><p>{card.body}</p><small>{card.hint}</small></div></div>)}
    </div>
  );
}

function ExpertSummary({ expert, active, onUse, onEdit, onCopy, onExport, onRemove }: { expert: ExpertDoc; active: boolean; onUse: () => void; onEdit: () => void; onCopy: () => void; onExport: () => void; onRemove: () => void }) {
  const draft = draftFromExpert(expert);
  const builtin = expert.source !== 'workspace';
  return <div className="expert-manager__summary">
    <div className="expert-manager__detail-head"><div><span className="expert-manager__eyebrow">EXPERT PROFILE</span><h1>{expert.name || expert.id}</h1><p>{expert.description || '还没有填写这个专家的工作说明。'}</p></div><span className={`expert-manager__status ${expert.enabled === false ? 'is-off' : ''}`}><span />{expert.enabled === false ? '已停用' : active ? '当前使用' : '已启用'}</span></div>
    <div className="expert-manager__facts">
      <div><Layers3 size={15} /><span>Skill</span><strong>{expert.skillCount ?? draft.skills.length} 项</strong></div>
      <div><ShieldCheck size={15} /><span>写入策略</span><strong>{describeWritePolicy(draft.capabilities.writePolicy)}</strong></div>
      <div><Link2 size={15} /><span>上下文</span><strong>{draft.capabilities.context.length} 项</strong></div>
      <div><Settings2 size={15} /><span>工具</span><strong>{draft.capabilities.tools.length} 项</strong></div>
    </div>
    <div className="expert-manager__summary-block"><span className="expert-manager__eyebrow">工作指令（正文即提示词）</span><p className="expert-manager__prompt">{draft.systemPrompt.trim() || '未设置额外指令。编辑专家，告诉它应该如何判断、处理和汇报。'}</p></div>
    <div className="expert-manager__summary-block"><span className="expert-manager__eyebrow">技能绑定</span>{draft.skills.length ? <div className="expert-manager__tags">{draft.skills.map((binding) => <span key={binding.id} className={`expert-manager__tag ${binding.enabled ? '' : 'is-off'}`}>{binding.id}·{binding.mode === 'discoverable' ? '按需' : '预载'}</span>)}</div> : <p className="expert-manager__hint">未绑定技能，只靠提示词工作。</p>}</div>
    <div className="expert-manager__summary-block"><span className="expert-manager__eyebrow">能力范围</span><p className="expert-manager__hint">上下文 {draft.capabilities.context.join(' / ') || '无'} · 工具 {draft.capabilities.tools.join(' / ') || '无'} · 轮数上限 {draft.capabilities.maxRounds} · 排除路径 {draft.capabilities.scopeExclude.join('、') || '无'}</p></div>
    <div className="expert-manager__summary-actions">
      <button type="button" className="btn btn--sm btn--primary" onClick={onUse}><Check size={15} />{active ? '继续使用' : '使用这个专家'}</button>
      <button type="button" className="btn btn--sm" onClick={onEdit}>{builtin ? '另存为副本' : '编辑配置'}</button>
      <button type="button" className="btn btn--sm" onClick={onExport}><FileDown size={15} />导出 .md</button>
      <button type="button" className="icon-btn" onClick={onCopy} title="复制专家" aria-label="复制专家"><Copy size={15} /></button>
      <button type="button" className="icon-btn icon-btn--danger" onClick={onRemove} disabled={builtin} title={builtin ? '内置专家不可删除' : '删除专家'} aria-label="删除专家"><Trash2 size={15} /></button>
    </div>
    <p className="expert-manager__hint">落盘：{builtin ? `<builtin>/experts/${expert.id}.md` : expertFilePath(expert.id)}</p>
  </div>;
}

function SkillSummary({ skill, onEdit, onCopy, onExport, onRemove }: { skill: SkillDoc; onEdit: () => void; onCopy: () => void; onExport: () => void; onRemove: () => void }) {
  const content = typeof skill.content === 'string' ? skill.content : '';
  const allowedTools = Array.isArray(skill.allowedTools) ? skill.allowedTools : [];
  const builtin = skill.source !== 'workspace';
  return (
    <div className="expert-manager__summary">
      <div className="expert-manager__detail-head">
        <div>
          <span className="expert-manager__eyebrow">REUSABLE METHOD · SKILL.md</span>
          <h1>{String(skill.title ?? skill.name ?? skill.id)}</h1>
          <p>{skill.description || '还没有填写这个 Skill 的用途（description 也是模型是否加载它的唯一依据）。'}</p>
        </div>
        <span className={`expert-manager__status ${skill.enabled === false ? 'is-off' : ''}`}><span />{skill.enabled === false ? '已停用' : '已启用'}</span>
      </div>
      <div className="expert-manager__facts">
        <div><BookOpen size={15} /><span>版本</span><strong>{String(skill.version || '2.0.0')}</strong></div>
        <div><Wrench size={15} /><span>预批准工具</span><strong>{allowedTools.length || '无'}</strong></div>
        <div><Layers3 size={15} /><span>许可证</span><strong>{String(skill.license ?? '—')}</strong></div>
        <div><ShieldCheck size={15} /><span>来源</span><strong>{builtin ? '内置' : '我的'}</strong></div>
      </div>
      <div className="expert-manager__summary-block">
        <span className="expert-manager__eyebrow">正文（模型加载后读到的部分）</span>
        <pre className="expert-manager__content-preview">{content.trim() || '还没有 Skill 正文。'}</pre>
      </div>
      <p className="expert-manager__hint">落盘：{builtin ? '<builtin>' : '.lattice'}/skills/{skill.id}/SKILL.md</p>
      <div className="expert-manager__summary-actions">
        <button type="button" className="btn btn--sm btn--primary" onClick={onEdit}>{builtin ? '复制并编辑' : '编辑 Skill'}</button>
        <button type="button" className="btn btn--sm" onClick={onExport}><FileDown size={15} />导出 SKILL.md</button>
        <button type="button" className="icon-btn" onClick={onCopy} title="复制 Skill" aria-label="复制 Skill"><Copy size={15} /></button>
        <button type="button" className="icon-btn icon-btn--danger" onClick={onRemove} disabled={builtin} title={builtin ? '内置 Skill 不可删除' : '删除 Skill'} aria-label="删除 Skill"><Trash2 size={15} /></button>
      </div>
    </div>
  );
}
function ManagerEmpty({ kind, onCreate }: { kind: ManagerTab; onCreate: () => void }) {
  return <div className="expert-manager__empty"><span className="expert-manager__empty-icon">{kind === 'experts' ? <Sparkles size={20} /> : <BookOpen size={20} />}</span><h2>{kind === 'experts' ? '还没有专家' : '还没有 Skill'}</h2><p>{kind === 'experts' ? '创建一个专家，把工作范围和权限固定下来。' : '创建一份 Skill，把可复用的工作方法写下来。'}</p><button type="button" className="btn btn--sm btn--primary" onClick={onCreate}><Plus size={15} />{kind === 'experts' ? '创建专家' : '创建 Skill'}</button></div>;
}

/** 专家编辑器：四区分组（基础 / 提示词 / 技能绑定 / 能力范围）。 */
function ExpertForm({ draft, skills, busy, onChange, onCancel, onSubmit }: { draft: ExpertDraft; skills: SkillDoc[]; busy: boolean; onChange: (draft: ExpertDraft | null) => void; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const set = (patch: Partial<ExpertDraft>) => onChange({ ...draft, ...patch });
  const setCapabilities = (patch: Partial<ExpertDraft['capabilities']>) => set({ capabilities: { ...draft.capabilities, ...patch } });
  const setRouting = (patch: Partial<ExpertDraft['routing']>) => set({ routing: { ...draft.routing, ...patch } });
  const binding = (id: string) => draft.skills.find((item) => item.id === id) ?? null;
  const toggleSkill = (id: string) => {
    const current = binding(id);
    set({ skills: current ? draft.skills.filter((item) => item.id !== id) : [...draft.skills, { id, enabled: true, mode: 'preload' }] });
  };
  const setBinding = (id: string, patch: Partial<ExpertSkillBinding>) => {
    set({ skills: draft.skills.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  };
  const promptLength = draft.systemPrompt.length;
  const overBudget = promptLength > EXPERT_PROMPT_MAX_CHARS;

  return <form className="expert-manager__form" onSubmit={onSubmit}>
    <div className="expert-manager__detail-head">
      <div><span className="expert-manager__eyebrow">EXPERT CONFIGURATION</span><h1>{draft.source ? '编辑专家' : '创建专家'}</h1><p>正文就是提示词；能力范围决定它能看见什么、能不能写。</p></div>
      <button type="button" className="icon-btn" onClick={onCancel} aria-label="取消编辑" title="取消"><X size={16} /></button>
    </div>

    <fieldset className="expert-form__section">
      <legend><span>01</span>基础</legend>
      <div className="expert-manager__form-grid">
        <label>名称<input value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="例如：Inbox 整理专家" /></label>
        <label>ID<input value={draft.id} disabled={Boolean(draft.source)} onChange={(event) => set({ id: event.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-') })} placeholder="例如：inbox-organizer" /></label>
      </div>
      <label>说明<input value={draft.description} onChange={(event) => set({ description: event.target.value })} placeholder="这个专家负责什么（同时用于路由与展示）" /></label>
      <div className="expert-manager__form-grid">
        <label>版本<input value={draft.version} onChange={(event) => set({ version: event.target.value })} placeholder="2.0.0" /></label>
        <label>图标<input value={draft.icon} onChange={(event) => set({ icon: event.target.value })} placeholder="sparkles" /></label>
      </div>
      <label className="expert-manager__switch"><input type="checkbox" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} /><span><strong>启用专家</strong><small>停用后不出现在选择器，也不参与路由建议</small></span></label>
    </fieldset>

    <fieldset className="expert-form__section">
      <legend><span>02</span>提示词</legend>
      <label>工作指令<textarea rows={8} value={draft.systemPrompt} onChange={(event) => set({ systemPrompt: event.target.value })} placeholder="告诉 AI 该专家的判断原则、工作方式与汇报口径。" /></label>
      <div className="expert-form__meta">
        <small>正文即 systemPrompt，运行时注入 system 消息；支持 <code>{'{{today}}'}</code> / <code>{'{{vaultName}}'}</code> 变量。</small>
        <small className={overBudget ? 'is-warn' : ''}>{promptLength} / {EXPERT_PROMPT_MAX_CHARS}</small>
      </div>
    </fieldset>

    <fieldset className="expert-form__section">
      <legend><span>03</span>技能绑定</legend>
      {skills.length ? <div className="expert-manager__bindings">{skills.map((skill) => {
        const current = binding(skill.id);
        return <div key={skill.id} className={`expert-manager__binding ${current ? 'is-checked' : ''}`}>
          <label className="expert-manager__binding-main"><input type="checkbox" checked={Boolean(current)} onChange={() => toggleSkill(skill.id)} /><span><strong>{String(skill.title ?? skill.name ?? skill.id)}</strong><small>{skill.description || '未填写说明'}</small></span></label>
          <select aria-label={`${String(skill.title ?? skill.name ?? skill.id)} 加载方式`} value={current?.mode ?? 'preload'} disabled={!current} onChange={(event) => setBinding(skill.id, { mode: event.target.value as SkillMode })}>
            {SKILL_MODE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </div>;
      })}</div> : <p className="expert-manager__hint">还没有可绑定的 Skill。</p>}
      <p className="expert-manager__hint">预载 = 会话开始即注入全文（单份 ≤6000 字）；按需 = 只常驻名称与说明，模型自己决定何时加载。</p>
    </fieldset>

    <fieldset className="expert-form__section">
      <legend><span>04</span>能力范围</legend>
      <div className="expert-manager__form-grid">
        <label>写入策略<select value={draft.capabilities.writePolicy} onChange={(event) => setCapabilities({ writePolicy: event.target.value as ExpertDraft['capabilities']['writePolicy'] })}>{WRITE_POLICY_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <label>轮数上限<input type="number" min={1} max={EXPERT_MAX_ROUNDS} value={draft.capabilities.maxRounds} onChange={(event) => setCapabilities({ maxRounds: Number(event.target.value) })} /></label>
      </div>
      <div className="expert-manager__form-grid">
        <label>路由关键词<input value={joinList(draft.routing.keywords)} onChange={(event) => setRouting({ keywords: splitList(event.target.value) })} placeholder="整理、归档、Inbox" /></label>
        <label>路由优先级<input type="number" min={0} max={100} value={draft.routing.priority} onChange={(event) => setRouting({ priority: Number(event.target.value) })} /></label>
      </div>
      <fieldset className="expert-form__inline"><legend>可读取范围</legend><div className="expert-manager__checks">{CONTEXT_OPTIONS.map((item) => <label key={item.id} className={draft.capabilities.context.includes(item.id) ? 'is-checked' : ''}><input type="checkbox" checked={draft.capabilities.context.includes(item.id)} onChange={() => setCapabilities({ context: toggleList(draft.capabilities.context, item.id) })} /><span>{item.label}</span></label>)}</div></fieldset>
      <fieldset className="expert-form__inline"><legend>能力工具</legend><div className="expert-manager__checks">{TOOL_OPTIONS.map((item) => <label key={item.id} className={draft.capabilities.tools.includes(item.id) ? 'is-checked' : ''}><input type="checkbox" checked={draft.capabilities.tools.includes(item.id)} onChange={() => setCapabilities({ tools: toggleList(draft.capabilities.tools, item.id) })} /><span>{item.label}</span></label>)}</div></fieldset>
      <label>写入排除路径<input value={joinList(draft.capabilities.scopeExclude)} onChange={(event) => setCapabilities({ scopeExclude: splitList(event.target.value) })} placeholder=".lattice/、_templates/、.fc/" /><small className="expert-manager__hint">写操作命中这些前缀一律拒绝（只收紧，不放宽）。</small></label>
    </fieldset>

    <div className="expert-manager__form-actions">
      <span className="expert-manager__hint">保存到 {expertFilePath(draft.id || '<id>')}</span>
      <button type="button" className="btn btn--sm" onClick={onCancel}>取消</button>
      <button type="submit" className="btn btn--sm btn--primary" disabled={busy || overBudget}><Save size={15} />保存专家</button>
    </div>
  </form>;
}

function SkillForm({ draft, busy, onChange, onCancel, onSubmit }: { draft: SkillDraft; busy: boolean; onChange: (draft: SkillDraft | null) => void; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const set = (patch: Partial<SkillDraft>) => onChange({ ...draft, ...patch });
  return (
    <form className="expert-manager__form" onSubmit={onSubmit}>
      <div className="expert-manager__detail-head">
        <div><span className="expert-manager__eyebrow">SKILL CONFIGURATION · SKILL.md</span><h1>{draft.source ? '编辑 Skill' : '创建 / 导入 Skill'}</h1><p>frontmatter 讲清楚「做什么、什么时候用」，正文写方法。</p></div>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="取消编辑" title="取消"><X size={16} /></button>
      </div>

      <fieldset className="expert-form__section">
        <legend><span>01</span>标识</legend>
        <div className="expert-manager__form-grid">
          <label>名称<input value={draft.title} onChange={(event) => set({ title: event.target.value })} placeholder="例如：知识库检索" /></label>
          <label>ID（= 目录名 / name）<input value={draft.id} disabled={Boolean(draft.source)} onChange={(event) => set({ id: event.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-') })} placeholder="例如：vault-search" /></label>
        </div>
        <label>说明（description：做什么 + 何时用）
          <textarea rows={3} value={draft.description} onChange={(event) => set({ description: event.target.value })} placeholder="围绕用户问题在知识库里检索并返回可引用证据。当用户问「之前记过什么」「给我出处」时使用。" />
        </label>
        <p className="expert-manager__hint">模型只靠这段说明决定要不要加载；写清触发场景（「当用户说…时使用」）比罗列关键词有效。</p>
      </fieldset>

      <fieldset className="expert-form__section">
        <legend><span>02</span>元数据</legend>
        <div className="expert-manager__form-grid">
          <label>版本<input value={draft.version} onChange={(event) => set({ version: event.target.value })} placeholder="2.0.0" /></label>
          <label>许可证<input value={draft.license} onChange={(event) => set({ license: event.target.value })} placeholder="MIT（可选）" /></label>
        </div>
        <div className="expert-manager__form-grid">
          <label>兼容性<input value={draft.compatibility} onChange={(event) => set({ compatibility: event.target.value })} placeholder="例如 lattice>=0.2（可选）" /></label>
          <label>预批准工具<input value={draft.allowedTools.join('、')} onChange={(event) => set({ allowedTools: splitList(event.target.value) })} placeholder="read、search（可选）" /></label>
        </div>
        <p className="expert-manager__hint">预批准工具只是「本回合免审批」的提示；真正能调什么由专家的工具面决定。</p>
        <label className="expert-manager__switch"><input type="checkbox" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} /><span><strong>启用 Skill</strong><small>停用后，绑定它的专家不会注入或列出这份方法</small></span></label>
      </fieldset>

      <fieldset className="expert-form__section">
        <legend><span>03</span>正文</legend>
        <label>方法正文
          <textarea className="expert-manager__skill-editor" rows={14} value={draft.content} onChange={(event) => set({ content: event.target.value })} placeholder="# 工作方法&#10;&#10;## 步骤&#10;1. " />
        </label>
        <p className="expert-manager__hint">上限 30000 字；预载注入时只取前 6000 字，长文档请放 references/ 并用文件读取工具按需查看。</p>
      </fieldset>

      <div className="expert-manager__form-actions">
        <span className="expert-manager__hint">保存到 {skillDirectoryPath(draft.id || '<id>')}SKILL.md</span>
        <button type="button" className="btn btn--sm" onClick={onCancel}>取消</button>
        <button type="submit" className="btn btn--sm btn--primary" disabled={busy}><Save size={15} />保存 Skill</button>
      </div>
    </form>
  );
}

/** 导入面板：文本 / 本地路径 / 链接三种来源，解析后进编辑器再保存。 */
function SkillImportPanel({ source, value, busy, onSource, onValue, onSubmit, onCancel }: { source: SkillImportSource; value: string; busy: boolean; onSource: (source: SkillImportSource) => void; onValue: (value: string) => void; onSubmit: () => void; onCancel: () => void }) {
  const options: Array<{ id: SkillImportSource; label: string }> = [
    { id: 'text', label: '粘贴文本' },
    { id: 'path', label: '本地文件 / 目录' },
    { id: 'url', label: '链接' },
  ];
  return (
    <div className="expert-manager__form">
      <div className="expert-manager__detail-head">
        <div><span className="expert-manager__eyebrow">IMPORT SKILL.md</span><h1>导入 Skill</h1><p>兼容 Agent Skills 规范：未知字段会被忽略，name 与 description 必填。</p></div>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="取消导入" title="取消"><X size={16} /></button>
      </div>
      <fieldset className="expert-form__section">
        <legend><span>01</span>来源</legend>
        <div className="expert-manager__checks">
          {options.map((option) => (
            <label key={option.id} className={source === option.id ? 'is-checked' : ''}>
              <input type="radio" name="skill-import-source" checked={source === option.id} onChange={() => onSource(option.id)} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        <label>{source === 'text' ? 'SKILL.md 内容' : source === 'path' ? '本机路径' : '链接'}
          {source === 'text'
            ? <textarea className="expert-manager__skill-editor" rows={12} value={value} onChange={(event) => onValue(event.target.value)} placeholder={SKILL_IMPORT_PLACEHOLDER[source]} />
            : <input value={value} onChange={(event) => onValue(event.target.value)} placeholder={SKILL_IMPORT_PLACEHOLDER[source]} />}
        </label>
        <p className="expert-manager__hint">导入只解析成草稿，不直接落盘；保存时仍会走文件确认。</p>
      </fieldset>
      <div className="expert-manager__form-actions">
        <button type="button" className="btn btn--sm" onClick={onCancel}>取消</button>
        <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={onSubmit}><Upload size={15} />解析为草稿</button>
      </div>
    </div>
  );
}

/** E4：LobeChat 角色卡导入（粘贴 JSON → 解析成专家草稿）。 */
function ExpertCardImportPanel({ value, busy, onValue, onSubmit, onCancel }: { value: string; busy: boolean; onValue: (value: string) => void; onSubmit: () => void; onCancel: () => void }) {
  return (
    <div className="expert-manager__form">
      <div className="expert-manager__detail-head">
        <div><span className="expert-manager__eyebrow">IMPORT CHARACTER CARD</span><h1>导入 LobeChat 角色卡</h1><p>粘贴单张角色卡 JSON（或数组取第一张）：标题 → 名称，systemRole → 提示词，tags → 路由关键词。</p></div>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="取消导入" title="取消"><X size={16} /></button>
      </div>
      <fieldset className="expert-form__section">
        <legend><span>01</span>角色卡 JSON</legend>
        <textarea className="expert-manager__skill-editor" rows={14} value={value} onChange={(event) => onValue(event.target.value)} placeholder={'{\n  "identifier": "rust-reviewer",\n  "meta": { "title": "Rust 评审", "tags": ["rust"] },\n  "config": { "systemRole": "你是一位严谨的 Rust 工程师。" }\n}'} />
        <p className="expert-manager__hint">只解析成草稿，不直接落盘；保存仍走文件确认。</p>
      </fieldset>
      <div className="expert-manager__form-actions">
        <button type="button" className="btn btn--sm" onClick={onCancel}>取消</button>
        <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={onSubmit}><Upload size={15} />解析为草稿</button>
      </div>
    </div>
  );
}

/** E4：`~/.claude/skills` 发现结果（只读列出，单个载入成 Skill 草稿）。 */
function ClaudeSkillsPanel({ items, onUse, onClose }: { items: Array<{ document: SkillDoc; markdown: string; installed: boolean }>; onUse: (document: SkillDoc) => void; onClose: () => void }) {
  return (
    <div className="expert-manager__form">
      <div className="expert-manager__detail-head">
        <div><span className="expert-manager__eyebrow">DISCOVER · ~/.claude/skills</span><h1>Claude 技能</h1><p>只读扫描；选择一个载入草稿，确认后写入你自己的知识库。</p></div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭列表" title="关闭"><X size={16} /></button>
      </div>
      {items.length ? <div className="expert-manager__items" role="listbox" aria-label="Claude 技能列表">{items.map((item) => (
        <button type="button" role="option" aria-selected={false} className="expert-manager__item" key={item.document.id} onClick={() => onUse(item.document)}>
          <BookOpen size={15} />
          <span><strong>{String(item.document.title ?? item.document.name ?? item.document.id)}</strong><small>{item.document.description || '未填写说明'}</small></span>
          {item.installed ? <em>已导入</em> : null}
        </button>
      ))}</div> : <p className="expert-manager__hint">~/.claude/skills 下没有找到 SKILL.md。</p>}
    </div>
  );
}

/** 剪贴板：优先异步 API，回退到隐藏 textarea（老 WebView）。 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走回退路径
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
