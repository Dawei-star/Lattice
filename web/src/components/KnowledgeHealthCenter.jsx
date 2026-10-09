import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  FolderOpen,
  Inbox,
  Link2Off,
  ListChecks,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Tags,
  TriangleAlert,
} from 'lucide-react';
import { reviewApi } from '../api/review.js';
import { formatNumber, formatRelativeTime } from '../lib/format.js';

const CATEGORY_META = {
  inbox: { label: 'Inbox 待整理', shortLabel: 'Inbox', description: '先收集、后归位的临时内容', icon: Inbox, tone: 'amber' },
  brokenLinks: { label: '悬空链接', shortLabel: '断链', description: '正文引用了尚不存在的笔记', icon: Link2Off, tone: 'red' },
  isolated: { label: '孤立笔记', shortLabel: '孤立', description: '没有出链，也没有被引用', icon: Activity, tone: 'blue' },
  stale: { label: '长期未更新', shortLabel: '沉默', description: '长时间没有维护且缺少反向链接', icon: Clock3, tone: 'slate' },
  duplicates: { label: '可能重复', shortLabel: '重复', description: '标题或正文高度相似，需人工确认', icon: Copy, tone: 'violet' },
  conflicts: { label: '内容冲突', shortLabel: '冲突', description: '同名内容存在差异，需要人工裁决', icon: TriangleAlert, tone: 'red' },
  metadata: { label: '元数据缺失', shortLabel: '元数据', description: '标签、来源或时间戳不完整', icon: ListChecks, tone: 'amber' },
  taxonomy: { label: '分类与标签', shortLabel: '分类', description: '发现标签或分类的近似写法', icon: Tags, tone: 'blue' },
  incomplete: { label: '结构不完整', shortLabel: '待补全', description: '缺少目录、标签或自定义属性', icon: Tags, tone: 'green' },
};

const EMPTY_CATEGORIES = Object.fromEntries(Object.keys(CATEGORY_META).map((key) => [key, []]));
const EVIDENCE_FILTERS = [
  { value: 'all', label: '全部线索' },
  { value: 'error', label: '确定问题' },
  { value: 'warning', label: '高风险候选' },
  { value: 'candidate', label: '候选线索' },
];
const MAX_BATCH_SELECTION = 20;
const PAGE_SIZE = 10;

export default function KnowledgeHealthCenter({ onOpenNote, onOpenInbox, onAskAi, onBack, onConfirmFileOperation, refreshKey = 0 }) {
  const [report, setReport] = useState(null);
  const [selected, setSelected] = useState('inbox');
  const [evidenceFilter, setEvidenceFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectionNotice, setSelectionNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scanReason, setScanReason] = useState('initial');
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairNotice, setRepairNotice] = useState('');
  const scanRequestRef = useRef(0);
  const listRef = useRef(null);

  const scan = useCallback(async ({ reason = 'manual' } = {}) => {
    const requestId = ++scanRequestRef.current;
    setScanReason(reason);
    setLoading(true);
    setError('');
    try {
      const next = await reviewApi.health();
      if (requestId !== scanRequestRef.current) return;
      setReport(next);
      setSelectedIds(new Set());
      setSelectionNotice('');
      setPage(0);
      const firstProblem = Object.keys(CATEGORY_META).find((key) => (next?.categories?.[key] ?? []).length > 0);
      setSelected((current) => (next?.categories?.[current]?.length ? current : firstProblem ?? 'inbox'));
    } catch (requestError) {
      if (requestId === scanRequestRef.current) setError(requestError?.message ?? '知识库巡检失败');
    } finally {
      if (requestId === scanRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void scan({ reason: refreshKey ? 'sync' : 'initial' });
  }, [refreshKey, scan]);

  const categories = report?.categories ?? EMPTY_CATEGORIES;
  const meta = CATEGORY_META[selected];
  const items = categories[selected] ?? [];
  const summaryCounts = report?.summary?.counts ?? {};
  const totalIssues = report?.summary?.total ?? 0;
  const hardTotal = report?.summary?.hardTotal ?? 0;
  const candidateTotal = report?.summary?.candidateTotal ?? 0;
  const warningTotal = report?.summary?.warningTotal ?? 0;
  const healthScore = report?.summary?.healthScore ?? 100;
  const filteredItems = evidenceFilter === 'all'
    ? items
    : items.filter((item) => item.severity === evidenceFilter);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pagedItems = filteredItems.slice(pageStart, pageStart + PAGE_SIZE);
  const selectedFindings = useMemo(() => Object.entries(categories)
    .flatMap(([category, categoryItems]) => categoryItems.map((item) => ({ category, item, key: findingKey(category, item) })))
    .filter(({ key }) => selectedIds.has(key)), [categories, selectedIds]);
  const currentCategorySelected = filteredItems.length > 0 && filteredItems.every((item) => selectedIds.has(findingKey(selected, item)));

  const reviewPrompt = useMemo(() => {
    const countText = Object.entries(CATEGORY_META)
      .map(([key, item]) => `${item.label} ${summaryCounts[key] ?? 0} 项`)
      .join('、');
    return `请对当前 Vault 做一次只读知识健康巡检。已由本地扫描得到：${countText}。请逐项给出证据、判断确定性和建议优先级，不要写入、移动或删除任何文件。重点解释哪些问题适合人工处理，哪些可以交给后续的可确认操作方案。`;
  }, [summaryCounts]);

  const toggleFindingSelection = (category, item) => {
    const key = findingKey(category, item);
    if (!selectedIds.has(key) && selectedIds.size >= MAX_BATCH_SELECTION) {
      setSelectionNotice(`单批最多选择 ${MAX_BATCH_SELECTION} 条线索，请先取消一部分选择。`);
      return;
    }
    setSelectionNotice('');
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleCategorySelection = () => {
    if (!filteredItems.length) return;
    const keys = filteredItems.map((item) => findingKey(selected, item));
    if (currentCategorySelected) {
      setSelectedIds((current) => {
        const next = new Set(current);
        keys.forEach((key) => next.delete(key));
        return next;
      });
      setSelectionNotice('');
      return;
    }

    const next = new Set(selectedIds);
    let skipped = 0;
    keys.forEach((key) => {
      if (next.has(key)) return;
      if (next.size >= MAX_BATCH_SELECTION) skipped += 1;
      else next.add(key);
    });
    setSelectedIds(next);
    setSelectionNotice(skipped ? `已选择 ${MAX_BATCH_SELECTION} 条，另有 ${skipped} 条未加入本批。` : '');
  };

  const generateBatchPlan = async () => {
    if (!selectedFindings.length) return;
    setRepairBusy(true);
    setRepairNotice('');
    try {
      const plan = await reviewApi.createPlan(selectedFindings.map(({ item }) => item.id));
      if (!plan?.summary?.changes) {
        setRepairNotice(plan?.manual?.length
          ? `本批没有可安全自动执行的变更，${plan.manual.length} 项已保留为人工处理。`
          : '本批没有需要执行的变更。');
        return;
      }
      const confirmation = await onConfirmFileOperation?.({
        type: plan.summary.deletes ? 'delete' : 'update',
        actions: plan.changes.map((action) => ({
          ...action,
          contentSummary: action.summary,
        })),
        summary: `健康修复计划：${plan.summary.changes} 项变更，${plan.summary.manual} 项需人工处理`,
        impact: '将更新可安全归一化的笔记元数据/标签，或删除已确认的完全重复副本',
        reversible: true,
        requiresSecondConfirmation: plan.confirmation.secondConfirmationRequired,
      });
      if (!confirmation?.confirmed) return;
      const result = await reviewApi.executePlan(plan.id, plan.planHash, confirmation);
      setRepairNotice(`已完成 ${result.completed} 项，失败 ${result.failed} 项，保留 ${result.skipped} 项待人工处理。`);
      await scan({ reason: 'repair' });
    } catch (requestError) {
      setRepairNotice(requestError?.message ?? '健康修复计划执行失败，请重新扫描后重试');
    } finally {
      setRepairBusy(false);
    }
  };

  const selectCategory = (key) => {
    setSelected(key);
    setPage(0);
  };

  const selectEvidenceFilter = (value) => {
    if (value === evidenceFilter) return;
    setEvidenceFilter(value);
    setSelectedIds(new Set());
    setSelectionNotice('');
    setPage(0);
  };

  const changePage = (nextPage) => {
    setPage(nextPage);
    // 等下一帧列表重渲染完成后再瞬时定位，避免平滑滚动被入场动画打断
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        listRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      });
    });
  };

  return (
    <section className="health-center" aria-label="知识健康中心">
      <header className="health-center__header">
        <div className="health-center__heading">
          <div className="health-center__mark" aria-hidden="true"><Activity size={22} strokeWidth={1.8} /></div>
          <div>
            <span className="health-center__eyebrow">KNOWLEDGE REVIEW / LOCAL SCAN</span>
            <h1>知识健康</h1>
            <p>把知识库里的结构问题变成一组可判断、可回溯的维护任务。</p>
          </div>
        </div>
        <div className="health-center__actions">
          <button type="button" className="btn" onClick={onBack} title="返回笔记视图">
            <FolderOpen size={15} strokeWidth={1.8} aria-hidden="true" />
            返回笔记
          </button>
          <button type="button" className="btn" onClick={() => onAskAi?.({ expertId: 'knowledge-curator', prompt: reviewPrompt })} disabled={loading}>
            <Sparkles size={15} strokeWidth={1.8} aria-hidden="true" />
            AI 给出建议
          </button>
          <button type="button" className="btn btn--primary" onClick={() => scan()} disabled={loading} title="重新扫描知识库">
            <RefreshCw size={15} strokeWidth={1.8} className={loading ? 'is-spinning' : undefined} aria-hidden="true" />
            {loading ? (scanReason === 'sync' ? '重新验证中…' : '扫描中…') : '重新扫描'}
          </button>
        </div>
      </header>

      {error ? (
        <div className="health-center__error" role="alert">
          <TriangleAlert size={17} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" className="btn btn--sm" onClick={() => scan()}>重试</button>
        </div>
      ) : null}
      {repairNotice ? <div className="health-center__selection-notice" role="status">{repairNotice}</div> : null}

      <div className="health-center__summary" aria-label="知识库健康摘要">
        <div className="health-center__summary-row">
          <div className="health-center__summary-main">
            <span className="health-center__summary-label">待处理线索</span>
            <strong className={totalIssues === 0 && !loading ? 'is-clean' : totalIssues > 30 ? 'is-heavy' : undefined}>
              {loading ? '—' : formatNumber(totalIssues)}
            </strong>
            <span>项需要判断</span>
          </div>
           <div className="health-center__summary-breakdown" aria-label="问题可信度构成">
             <span><strong>{loading ? '—' : formatNumber(hardTotal)}</strong> 确定问题</span>
             <span><strong>{loading ? '—' : formatNumber(warningTotal)}</strong> 高风险候选</span>
             <span><strong>{loading ? '—' : formatNumber(candidateTotal)}</strong> 候选线索</span>
           </div>
           <div className="health-center__summary-stat"><span>健康度</span><strong className={healthScore >= 80 ? 'is-clean' : healthScore < 50 ? 'is-heavy' : undefined}>{loading ? '—' : `${healthScore} / 100`}</strong></div>
          <div className="health-center__summary-stat"><span>扫描笔记</span><strong>{loading ? '—' : formatNumber(report?.noteCount ?? 0)}</strong></div>
          <div className="health-center__summary-stat"><span>沉默阈值</span><strong>{report?.staleDays ?? 90} 天</strong></div>
          <div className="health-center__summary-meta" aria-live="polite">
            {loading
              ? (scanReason === 'sync' ? '正在验证最新投影…' : '正在扫描本地知识库…')
              : report?.scannedAt ? `最近扫描 ${formatRelativeTime(report.scannedAt)}` : '等待本地扫描'}
          </div>
        </div>
        {!loading && totalIssues > 0 ? (
          <div className="health-center__composition" role="img" aria-label={`问题构成：${Object.entries(CATEGORY_META).filter(([key]) => (summaryCounts[key] ?? 0) > 0).map(([key, item]) => `${item.label} ${summaryCounts[key]} 项`).join('，')}`}>
            {Object.entries(CATEGORY_META).map(([key, category]) => {
              const count = summaryCounts[key] ?? 0;
              if (!count) return null;
              return <span key={key} className={`tone-${category.tone}`} style={{ '--w': count }} title={`${category.label} ${count} 项`} />;
            })}
          </div>
        ) : null}
      </div>

      <div className="health-center__body">
        <nav className="health-center__rail" aria-label="健康问题分类">
          <span className="health-center__rail-label">REVIEW QUEUE</span>
          {Object.entries(CATEGORY_META).map(([key, category]) => {
            const Icon = category.icon;
            const count = summaryCounts[key] ?? 0;
            return (
              <button
                type="button"
                key={key}
                className={`health-center__category health-center__category--${category.tone} ${selected === key ? 'is-active' : ''}`}
                onClick={() => selectCategory(key)}
                aria-current={selected === key ? 'page' : undefined}
              >
                <span className="health-center__category-icon"><Icon size={16} strokeWidth={1.8} aria-hidden="true" /></span>
                <span className="health-center__category-copy"><strong>{category.shortLabel}</strong><small>{category.description}</small></span>
                <span className="health-center__category-count">{loading ? '—' : count}</span>
              </button>
            );
          })}
          <div className="health-center__rail-note"><CheckCircle2 size={14} aria-hidden="true" /><span>扫描只读，不会自动改动 Vault。</span></div>
        </nav>

        <div className="health-center__results">
          <header className="health-center__results-head">
            <div>
              <span className="health-center__eyebrow">{meta?.shortLabel ?? 'REVIEW'}</span>
              <h2>{meta?.label ?? '健康检查'}</h2>
              <p>{meta?.description ?? ''}</p>
            </div>
            <div className="health-center__results-tools">
              {!loading && items.length > 0 ? (
                <button type="button" className="btn btn--sm" onClick={toggleCategorySelection} aria-label={currentCategorySelected ? '取消选择本类问题' : '选择本类问题'}>
                  {currentCategorySelected ? '取消本类' : '选择本类'}
                </button>
              ) : null}
              {!loading && items.length > 0 ? (
                <div className="health-center__evidence-filter" role="group" aria-label="按证据级别筛选">
                  {EVIDENCE_FILTERS.map((filter) => (
                    <button
                      type="button"
                      key={filter.value}
                      className={evidenceFilter === filter.value ? 'is-active' : undefined}
                      aria-pressed={evidenceFilter === filter.value}
                      onClick={() => selectEvidenceFilter(filter.value)}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {items.length > 0 ? (
                <span className="health-center__result-count">
                  {evidenceFilter === 'all' ? `${items.length} 项` : `${filteredItems.length} / ${items.length} 项`}
                </span>
              ) : null}
            </div>
          </header>
          {selectedFindings.length ? (
            <div className="health-center__batch-bar" role="status">
              <div><ListChecks size={15} aria-hidden="true" /><strong>已选择 {selectedFindings.length} 条线索</strong><span>将限定在这些问题内生成统一方案</span></div>
              <div className="health-center__batch-actions">
                <button type="button" className="btn btn--sm" onClick={() => { setSelectedIds(new Set()); setSelectionNotice(''); }}>清空选择</button>
                <button type="button" className="btn btn--sm btn--primary" onClick={generateBatchPlan} disabled={repairBusy}>
                  <Sparkles size={13} strokeWidth={1.8} aria-hidden="true" />{repairBusy ? '生成/执行中…' : '生成修复计划'}
                </button>
              </div>
            </div>
          ) : null}
          {selectionNotice ? <div className="health-center__selection-notice" role="alert">{selectionNotice}</div> : null}
          {loading ? <HealthSkeleton /> : filteredItems.length ? (
            <div className="health-center__list-area" ref={listRef}>
              <div className="health-center__finding-list">
                {pagedItems.map((item, index) => (
                  <Finding
                    key={item.id}
                    category={selected}
                    item={item}
                    index={index}
                    selected={selectedIds.has(findingKey(selected, item))}
                    onToggleSelect={toggleFindingSelection}
                    onOpenNote={onOpenNote}
                    onOpenInbox={onOpenInbox}
                    onAskAi={onAskAi}
                  />
                ))}
              </div>
              {pageCount > 1 ? (
                <HealthPagination
                  page={safePage}
                  pageCount={pageCount}
                  total={filteredItems.length}
                  pageStart={pageStart}
                  pageSize={PAGE_SIZE}
                  onPageChange={changePage}
                />
              ) : null}
            </div>
          ) : items.length ? (
            <div className="health-center__empty health-center__empty--filtered">
              <TriangleAlert size={28} strokeWidth={1.5} aria-hidden="true" />
              <strong>当前筛选没有匹配线索</strong>
              <span>本类仍有 {items.length} 项，切换到“全部线索”查看。</span>
              <button type="button" className="btn btn--sm" onClick={() => selectEvidenceFilter('all')}>查看全部</button>
            </div>
          ) : (
            <div className="health-center__empty">
              <CheckCircle2 size={28} strokeWidth={1.5} aria-hidden="true" />
              <strong>这一类目前没有发现问题</strong>
              <span>继续记录，定期回来做一次本地扫描。</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Finding({ category, item, index = 0, selected, onToggleSelect, onOpenNote, onOpenInbox, onAskAi }) {
  const isGroup = category === 'duplicates' || category === 'conflicts';
  const prompt = buildActionPrompt(category, item);
  return (
    <article
      className={`health-finding health-finding--${category} ${selected ? 'is-selected' : ''}`}
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
    >
      <label className="health-finding__select" title={selected ? '取消选择这条线索' : '选择这条线索'}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect?.(category, item)}
          aria-label={`选择${categoryLabel(category)}：${item.title ?? item.targetTitle ?? '这条线索'}`}
        />
      </label>
      <div className="health-finding__marker" aria-hidden="true" />
      <div className="health-finding__body">
        <div className="health-finding__topline">
          <div className="health-finding__title-wrap">
            <h3>{category === 'conflicts' ? '同名内容冲突' : isGroup ? '可能重复的笔记' : item.title ?? item.targetTitle}</h3>
            {item.severity === 'error' ? (
              <span className="health-finding__badge health-finding__badge--error"><ShieldCheck size={11} aria-hidden="true" />确定问题</span>
            ) : item.severity === 'warning' ? (
              <span className="health-finding__badge health-finding__badge--warning"><TriangleAlert size={11} aria-hidden="true" />高风险候选</span>
            ) : (
              <span className="health-finding__badge">候选线索</span>
            )}
          </div>
          <span className="health-finding__kind">{categoryLabel(category)}</span>
        </div>
        <p className="health-finding__reason">{item.reason}</p>
        {item.path ? <code className="health-finding__path">{item.path}</code> : null}
        {item.missing?.length ? <div className="health-finding__chips">{item.missing.map((value) => <span key={value}>{value}</span>)}</div> : null}
        {category === 'brokenLinks' ? <SourceList sources={item.sources} onOpenNote={onOpenNote} /> : null}
        {isGroup ? <SourceList sources={item.notes} onOpenNote={onOpenNote} /> : null}
      </div>
      <div className="health-finding__actions">
        {!isGroup && item.id && category !== 'brokenLinks' ? (
          <button type="button" className="icon-btn" onClick={() => onOpenNote?.(item.id)} title="打开笔记" aria-label="打开笔记"><ArrowUpRight size={15} /></button>
        ) : null}
        {category === 'inbox' ? <button type="button" className="btn btn--sm" onClick={onOpenInbox}>打开 Inbox</button> : null}
        <button type="button" className="btn btn--sm btn--review-ai" onClick={() => onAskAi?.({ expertId: 'general', prompt })} title="生成可确认的操作方案">
          <Sparkles size={13} strokeWidth={1.8} aria-hidden="true" />
          生成方案
        </button>
      </div>
    </article>
  );
}

function HealthPagination({ page, pageCount, total, pageStart, pageSize, onPageChange }) {
  const entries = pageEntries(page, pageCount);
  const rangeEnd = Math.min(pageStart + pageSize, total);
  return (
    <nav className="health-center__pagination" aria-label="结果分页">
      <span className="health-center__pagination-info">
        显示 {pageStart + 1}–{rangeEnd} 项 · 共 {formatNumber(total)} 项
      </span>
      <div className="health-center__pagination-pages">
        <button
          type="button"
          className="health-page-btn"
          onClick={() => onPageChange?.(page - 1)}
          disabled={page <= 0}
          aria-label="上一页"
          title="上一页"
        >
          <ChevronLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        {entries.map((entry, index) => (
          entry === 'gap' ? (
            <span key={`gap-${index}`} className="health-center__pagination-gap" aria-hidden="true">…</span>
          ) : (
            <button
              type="button"
              key={entry}
              className={`health-page-btn ${entry - 1 === page ? 'is-current' : ''}`}
              onClick={() => onPageChange?.(entry - 1)}
              aria-label={`第 ${entry} 页`}
              aria-current={entry - 1 === page ? 'page' : undefined}
            >
              {entry}
            </button>
          )
        ))}
        <button
          type="button"
          className="health-page-btn"
          onClick={() => onPageChange?.(page + 1)}
          disabled={page >= pageCount - 1}
          aria-label="下一页"
          title="下一页"
        >
          <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

function pageEntries(page, pageCount) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages = new Set([1, pageCount]);
  if (page <= 3) {
    for (let value = 2; value <= 5; value += 1) pages.add(value);
  } else if (page >= pageCount - 2) {
    for (let value = pageCount - 4; value < pageCount; value += 1) pages.add(value);
  } else {
    for (let value = page - 1; value <= page + 1; value += 1) pages.add(value);
  }
  return [...pages].sort((left, right) => left - right).flatMap((value, index, sorted) => {
    const previous = index > 0 ? sorted[index - 1] : 0;
    return value - previous > 1 ? ['gap', value] : [value];
  });
}

function SourceList({ sources = [], onOpenNote }) {
  if (!sources.length) return null;
  return (
    <div className="health-finding__sources">
      {sources.slice(0, 4).map((source) => (
        <button type="button" key={source.id} onClick={() => onOpenNote?.(source.id)} title={source.path ?? source.title}>
          <span>{source.title}</span><ChevronRight size={13} aria-hidden="true" />
        </button>
      ))}
      {sources.length > 4 ? <small>还有 {sources.length - 4} 篇来源</small> : null}
    </div>
  );
}

function HealthSkeleton() {
  return <div className="health-center__finding-list" aria-hidden="true">{[0, 1, 2].map((key) => <div className="health-finding health-finding--skeleton" key={key}><div className="skeleton__line skeleton__line--title" /><div className="skeleton__line" /><div className="skeleton__line skeleton__line--short" /></div>)}</div>;
}

function categoryLabel(category) {
  return CATEGORY_META[category]?.shortLabel ?? category;
}

function buildActionPrompt(category, item) {
  const evidence = category === 'brokenLinks'
    ? `目标「${item.targetTitle}」，来源：${(item.sources ?? []).map((source) => source.path).join('、')}`
    : category === 'duplicates' || category === 'conflicts'
      ? (item.notes ?? []).map((note) => `${note.path}（${note.title}）`).join('、')
      : `${item.path ?? item.title}：${item.reason}`;
  return `请处理知识健康 Review 中这条线索：${categoryLabel(category)}。证据是：${evidence}。先读取相关文件并说明判断依据，再生成可预览的操作方案；任何移动、改写、合并或删除都必须等待我确认，不能直接执行。无法确定时保留原文件并说明原因。`;
}

function findingKey(category, item) {
  return `${category}:${item?.id ?? item?.targetTitle ?? item?.path ?? 'unknown'}`;
}

function buildBatchPrompt(findings) {
  const lines = findings.map(({ category, item }, index) => {
    const evidence = category === 'brokenLinks'
      ? `目标「${item.targetTitle}」，来源：${(item.sources ?? []).map((source) => source.path).join('、')}`
      : category === 'duplicates' || category === 'conflicts'
        ? (item.notes ?? []).map((note) => `${note.path}（${note.title}）`).join('、')
        : `${item.path ?? item.title}：${item.reason}`;
    return `${index + 1}. ${categoryLabel(category)} · ${evidence}`;
  }).join('\n');
  return `请为知识健康 Review 中用户勾选的 ${findings.length} 条线索生成一份统一的、可预览的操作方案。只处理下面列出的线索，不要扩大扫描范围：\n${lines}\n\n先读取涉及的文件，逐条说明判断依据和确定性；能安全修复的才提出 lattice-actions，无法确定的保留原状并说明原因。悬空链接不要未经确认自动创建目标笔记，可能重复不要直接合并或删除，孤立笔记不要凭空添加关系。所有移动、改写、补属性、合并或删除都必须停在操作预览等待我确认，不能直接执行。`;
}
