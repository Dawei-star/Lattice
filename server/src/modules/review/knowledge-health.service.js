import { createHash } from 'node:crypto';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { ConflictError, ValidationError } from '../../lib/errors.js';
import * as linksRepository from '../links/links.repository.js';
import * as linksService from '../links/links.service.js';
import * as notesRepository from '../notes/notes.repository.js';
import * as notesService from '../notes/notes.service.js';
import * as tagsRepository from '../tags/tags.repository.js';

const DEFAULT_STALE_DAYS = 90;
const MAX_ITEMS = 100;
const SYSTEM_PROPERTIES = new Set(['type', 'status']);
const HIGH_CONFIDENCE_FINDING = { status: 'open', severity: 'error', confidence: 'high', priority: 100 };
const REVIEW_FINDING = { status: 'open', severity: 'warning', confidence: 'review', priority: 70 };
const CANDIDATE_FINDING = { status: 'open', severity: 'candidate', confidence: 'review', priority: 40 };
const REPAIR_PLAN_TTL_MS = 15 * 60_000;
const repairPlans = new Map();

/**
 * 生成只读、可解释、可排序的知识健康报告。
 * 扫描不写盘；后续修复必须由调用方生成文件操作预览并取得用户确认。
 */
export function scan({ staleDays = DEFAULT_STALE_DAYS, limit = MAX_ITEMS } = {}) {
  const notes = notesRepository.listForHealth();
  const noteIds = notes.map((note) => note.id);
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const tagMap = tagsRepository.findTagsForNotes(noteIds);
  const allTags = tagsRepository.findAllWithCounts();
  const { outgoing, incoming } = linksService.countsForNotes(noteIds);
  const propertiesById = new Map(notes.map((note) => [note.id, notesService.readNoteProperties(note)]));

  const inbox = notes
    .filter((note) => {
      const properties = propertiesById.get(note.id) ?? {};
      return properties.type === 'inbox' && properties.status !== 'processed';
    })
    .map((note) => noteFinding(note, {
      reason: `Inbox 中仍处于「${propertiesById.get(note.id)?.status ?? 'captured'}」状态`,
      inboxStatus: propertiesById.get(note.id)?.status ?? 'captured',
      ...HIGH_CONFIDENCE_FINDING,
    }));

  const brokenLinks = buildBrokenLinks(noteById, limit);
  const isolated = notes
    .filter((note) => (outgoing.get(note.id) ?? 0) === 0 && (incoming.get(note.id) ?? 0) === 0)
    .map((note) => noteFinding(note, {
      reason: '没有出链，也没有其他笔记引用它',
      outgoingCount: 0,
      backlinkCount: 0,
      ...CANDIDATE_FINDING,
    }));

  const cutoff = Date.now() - staleDays * 86_400_000;
  const stale = notes
    .filter((note) => {
      const properties = propertiesById.get(note.id) ?? {};
      const updatedAt = Date.parse(note.updatedAt);
      return properties.type !== 'inbox'
        && Number.isFinite(updatedAt)
        && updatedAt < cutoff
        && (incoming.get(note.id) ?? 0) === 0;
    })
    .map((note) => noteFinding(note, {
      reason: `已超过 ${staleDays} 天未更新，且没有反向链接`,
      ageDays: Math.max(0, Math.floor((Date.now() - Date.parse(note.updatedAt)) / 86_400_000)),
      backlinkCount: 0,
      ...CANDIDATE_FINDING,
    }));

  const duplicates = findDuplicates(notes, limit);
  const conflicts = findConflicts(notes, limit);
  const metadata = findMetadataGaps(notes, propertiesById, tagMap, limit);
  const taxonomy = findTaxonomyIssues(notes, propertiesById, tagMap, allTags, limit);
  const incomplete = findLegacyStructureGaps(notes, propertiesById, tagMap, limit);

  const categories = {
    inbox: rankAndLimit(inbox, limit),
    brokenLinks: rankAndLimit(brokenLinks, limit),
    isolated: rankAndLimit(isolated, limit),
    stale: rankAndLimit(stale, limit),
    duplicates: rankAndLimit(duplicates, limit),
    conflicts: rankAndLimit(conflicts, limit),
    metadata: rankAndLimit(metadata, limit),
    taxonomy: rankAndLimit(taxonomy, limit),
    incomplete: rankAndLimit(incomplete, limit),
  };
  const findings = Object.values(categories).flat().sort(compareFindings);
  const counts = Object.fromEntries(Object.entries(categories).map(([key, items]) => [key, items.length]));
  const hardTotal = findings.filter((item) => item.severity === 'error').length;
  const warningTotal = findings.filter((item) => item.severity === 'warning').length;
  const candidateTotal = findings.filter((item) => item.severity === 'candidate').length;
  const weighted = findings.reduce((sum, item) => sum + (item.severity === 'error' ? 2 : 1), 0);
  const healthScore = notes.length ? Math.max(0, Math.round(100 - (weighted / (notes.length * 2)) * 100)) : 100;

  return {
    scannedAt: new Date().toISOString(),
    noteCount: notes.length,
    staleDays,
    limits: { perCategory: limit },
    summary: {
      total: findings.length,
      counts,
      hardTotal,
      warningTotal,
      candidateTotal,
      healthScore,
      topPriority: findings.slice(0, 20).map((item) => ({ id: item.id, kind: item.kind, priority: item.priority })),
    },
    categories,
    prioritized: findings.slice(0, Math.max(limit, 20)),
  };
}

/**
 * 根据扫描结果生成可审阅的修复计划。计划只保存在内存中，执行前会重新校验笔记版本，
 * 因此扫描之后的外部修改不会被旧计划静默覆盖。
 */
export function createRepairPlan({ findingIds = [], staleDays = DEFAULT_STALE_DAYS, limit = MAX_ITEMS } = {}) {
  if (!Array.isArray(findingIds) || findingIds.length < 1 || findingIds.length > MAX_ITEMS) {
    throw new ValidationError(`一次修复计划必须包含 1-${MAX_ITEMS} 条线索`);
  }

  const report = scan({ staleDays, limit });
  const selected = new Set(findingIds.map((id) => String(id)));
  const findings = Object.entries(report.categories)
    .flatMap(([category, items]) => items.map((item) => ({ category, item })))
    .filter(({ item }) => selected.has(String(item.id)));
  const missingFindingIds = findingIds.filter((id) => !findings.some(({ item }) => String(item.id) === String(id)));
  if (missingFindingIds.length) {
    throw new ValidationError('部分健康线索已不在当前扫描结果中，请重新扫描后再生成计划', [
      { field: 'findingIds', missing: missingFindingIds },
    ]);
  }

  const notes = notesRepository.listForHealth();
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const propertiesById = new Map(notes.map((note) => [note.id, notesService.readNoteProperties(note)]));
  const updateStates = new Map();
  const deleteActions = new Map();
  const manual = [];

  const addManual = (category, item, reason) => manual.push({
    findingId: item.id,
    category,
    title: item.title ?? item.targetTitle ?? null,
    reason,
  });

  const stateFor = (noteId) => {
    const note = noteById.get(noteId);
    if (!note) return null;
    if (!updateStates.has(noteId)) {
      updateStates.set(noteId, {
        note,
        properties: { ...(propertiesById.get(noteId) ?? {}) },
        content: note.content,
        propertyChanged: false,
        contentChanged: false,
        summaries: [],
      });
    }
    return updateStates.get(noteId);
  };

  const updateProperties = (noteId, mutate, summary) => {
    const state = stateFor(noteId);
    if (!state) return false;
    const before = JSON.stringify(state.properties);
    mutate(state.properties);
    if (JSON.stringify(state.properties) === before) return false;
    state.propertyChanged = true;
    state.summaries.push(summary);
    return true;
  };

  const updateContent = (noteId, nextContent, summary) => {
    const state = stateFor(noteId);
    if (!state || state.content === nextContent) return false;
    state.content = nextContent;
    state.contentChanged = true;
    state.summaries.push(summary);
    return true;
  };

  for (const { category, item } of findings) {
    if (category === 'metadata' && item.id && noteById.has(item.id)) {
      const missing = new Set(item.missing ?? []);
      let changed = false;
      if (missing.has('来源')) {
        const note = noteById.get(item.id);
        changed = updateProperties(item.id, (properties) => {
          properties.source = `vault:${note.filePath || `${note.title}.md`}`;
        }, '补全来源为当前 Vault 路径') || changed;
      }
      if (missing.has('标签')) {
        addManual(category, item, '缺少可可靠推断的标签，保留原文并等待人工选择标签');
      }
      if (missing.has('时间戳')) {
        addManual(category, item, '时间戳缺失，不能凭推测覆盖原始时间；请人工核对文件历史');
      }
      if (!changed && !missing.has('标签') && !missing.has('时间戳')) {
        addManual(category, item, '没有可安全自动补全的元数据');
      }
      continue;
    }

    if (category === 'taxonomy' && item.issueType === 'tag-alias') {
      const aliases = item.tags ?? [];
      const canonical = item.suggestedCanonical;
      for (const noteId of item.noteIds ?? []) {
        const state = stateFor(noteId);
        if (!state) continue;
        const rawTags = state.properties.tags;
        const tags = Array.isArray(rawTags)
          ? rawTags
          : typeof rawTags === 'string' ? rawTags.split(/[,，、]/) : [];
        const normalizedTags = [...new Set(tags.map((tag) => canonicalizeAlias(tag, aliases, canonical)).filter(Boolean))];
        const changedTags = normalizedTags.length > 0 && JSON.stringify(normalizedTags) !== JSON.stringify(tags);
        if (changedTags) updateProperties(noteId, (properties) => { properties.tags = normalizedTags; }, `标签归一为「${canonical}」`);
        let content = state.content;
        for (const alias of aliases) {
          if (alias !== canonical) content = replaceInlineTag(content, alias, canonical);
        }
        if (content !== state.content) updateContent(noteId, content, `正文标签归一为「${canonical}」`);
      }
      if (!(item.noteIds ?? []).length) addManual(category, item, '没有找到受影响笔记，需人工核对标签来源');
      continue;
    }

    if (category === 'taxonomy' && item.issueType === 'category-alias') {
      const canonical = chooseCanonical(item.variants ?? []);
      for (const noteId of item.noteIds ?? []) {
        updateProperties(noteId, (properties) => { properties.category = canonical; }, `分类归一为「${canonical}」`);
      }
      if (!(item.noteIds ?? []).length) addManual(category, item, '没有找到受影响笔记，需人工核对分类来源');
      continue;
    }

    if (category === 'duplicates' && item.evidence?.includes('标题相同') && item.evidence?.includes('正文高度一致')) {
      const group = (item.noteIds ?? []).map((id) => noteById.get(id)).filter(Boolean);
      const survivor = [...group].sort(compareNotesForMerge)[0];
      for (const note of group) {
        if (note.id === survivor?.id) continue;
        deleteActions.set(note.id, {
          id: `delete:${note.id}`,
          type: 'delete',
          noteId: note.id,
          replacementId: survivor.id,
          path: note.filePath || `${note.title}.md`,
          summary: `删除与「${survivor.title}」完全重复的副本，并将反向链接迁移到保留笔记`,
          fullPath: absolutePath(note.filePath || `${note.title}.md`),
          directory: path.dirname(absolutePath(note.filePath || `${note.title}.md`)),
          beforeHash: note.contentHash,
          reversible: true,
        });
      }
      continue;
    }

    if (category === 'duplicates') {
      addManual(category, item, '仅凭当前证据无法判断保留版本，暂不合并或删除');
    } else if (category === 'conflicts') {
      addManual(category, item, '同名笔记内容存在差异，需要人工裁决后才能合并');
    } else if (category === 'stale') {
      addManual(category, item, '过时内容不能由系统凭空改写，需要人工核对来源后更新');
    } else if (category === 'brokenLinks') {
      addManual(category, item, '断链目标不明确，需人工选择创建目标或修改引用');
    } else if (category === 'inbox') {
      addManual(category, item, 'Inbox 归类需要结合上下文，保留在 Inbox 等待人工归档');
    } else if (category === 'isolated' || category === 'incomplete') {
      addManual(category, item, '结构调整会改变知识组织方式，暂不自动移动或补造关系');
    } else {
      addManual(category, item, '当前线索没有安全的自动修复动作');
    }
  }

  const actions = [
    ...[...updateStates.values()]
      .filter((state) => (state.propertyChanged || state.contentChanged) && !deleteActions.has(state.note.id))
      .map((state) => ({
        id: `update:${state.note.id}`,
        type: 'update',
        noteId: state.note.id,
        path: state.note.filePath || `${state.note.title}.md`,
        patch: {
          ...(state.contentChanged ? { content: state.content } : {}),
          ...(state.propertyChanged ? { properties: state.properties } : {}),
          expectedHash: state.note.contentHash,
        },
        summary: state.summaries.join('；'),
        fullPath: absolutePath(state.note.filePath || `${state.note.title}.md`),
        directory: path.dirname(absolutePath(state.note.filePath || `${state.note.title}.md`)),
        beforeHash: state.note.contentHash,
        reversible: true,
      })),
    ...deleteActions.values(),
  ];
  const planId = randomUUID();
  const planHash = createHash('sha256').update(JSON.stringify({
    version: 1,
    actions,
    manual,
  })).digest('hex');
  const plan = {
    id: planId,
    version: 1,
    planHash,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + REPAIR_PLAN_TTL_MS).toISOString(),
    findingIds: [...selected],
    actions,
    manual,
  };
  repairPlans.set(planId, plan);
  prunePlans();
  return publicPlan(plan);
}

export function executeRepairPlan({ planId, planHash, actor = 'local-user' } = {}) {
  prunePlans();
  const plan = repairPlans.get(planId);
  if (!plan) throw new ConflictError('修复计划已过期，请重新生成健康修复计划');
  if (plan.planHash !== planHash) throw new ConflictError('修复计划已变化，请重新生成预览');

  const results = [];
  for (const action of plan.actions) {
    try {
      const current = notesRepository.findById(action.noteId);
      if (!current || current.contentHash !== action.beforeHash) {
        throw new ConflictError('目标笔记已变化，请重新扫描后生成计划');
      }
      let result;
      if (action.type === 'delete') {
        result = notesService.remove(action.noteId, { replacementId: action.replacementId });
      } else {
        result = notesService.update(action.noteId, action.patch);
      }
      results.push({ id: action.id, type: action.type, path: action.path, status: 'completed', summary: action.summary, result });
    } catch (error) {
      results.push({ id: action.id, type: action.type, path: action.path, status: 'failed', summary: action.summary, error: error.message });
    }
  }
  repairPlans.delete(planId);
  return {
    planId,
    actor,
    results,
    manual: plan.manual,
    completed: results.filter((item) => item.status === 'completed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: plan.manual.length,
  };
}

export function planRequiresSecondConfirmation({ planId, planHash } = {}) {
  prunePlans();
  const plan = repairPlans.get(planId);
  if (!plan) throw new ConflictError('修复计划已过期，请重新生成健康修复计划');
  if (plan.planHash !== planHash) throw new ConflictError('修复计划已变化，请重新生成预览');
  return plan.actions.some((action) => action.type === 'delete');
}

function publicPlan(plan) {
  const actions = plan.actions.map(({ patch: _patch, beforeHash: _beforeHash, ...action }) => action);
  return {
    id: plan.id,
    version: plan.version,
    planHash: plan.planHash,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    findingIds: plan.findingIds,
    actions,
    changes: actions,
    manual: plan.manual,
    summary: {
      total: actions.length + plan.manual.length,
      changes: actions.length,
      manual: plan.manual.length,
      deletes: actions.filter((action) => action.type === 'delete').length,
    },
    confirmation: {
      required: actions.length > 0,
      secondConfirmationRequired: actions.some((action) => action.type === 'delete'),
      itemCount: actions.length,
      deleteCount: actions.filter((action) => action.type === 'delete').length,
      paths: actions.map((action) => action.fullPath),
    },
  };
}

function prunePlans() {
  const now = Date.now();
  for (const [id, plan] of repairPlans) {
    if (Date.parse(plan.expiresAt) <= now) repairPlans.delete(id);
  }
}

function absolutePath(relativePath) {
  return path.resolve(config.vaultDir, String(relativePath).replaceAll('/', path.sep));
}

function compareNotesForMerge(left, right) {
  return String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
    || String(left.id).localeCompare(String(right.id));
}

function chooseCanonical(values) {
  return [...values].sort((left, right) => String(left).length - String(right).length || String(left).localeCompare(String(right), 'zh-CN'))[0] ?? '';
}

function canonicalizeAlias(value, aliases, canonical) {
  const source = String(value ?? '').trim().replace(/^#/, '');
  return aliases.some((alias) => normalizeTaxonomy(alias) === normalizeTaxonomy(source)) ? canonical : source;
}

function replaceInlineTag(content, alias, canonical) {
  const escaped = String(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return String(content ?? '').replace(new RegExp(`(?<![\\p{L}\\p{N}_#\\/])#${escaped}(?![\\p{L}\\p{N}_\\-])`, 'gu'), `#${canonical}`);
  } catch {
    return String(content ?? '');
  }
}

function buildBrokenLinks(noteById, limit) {
  const groups = new Map();
  for (const row of linksRepository.listDanglingDetails()) {
    const key = row.targetTitle.toLocaleLowerCase();
    if (!groups.has(key)) groups.set(key, { targetTitle: row.targetTitle, sources: [] });
    groups.get(key).sources.push({ id: row.sourceId, title: row.sourceTitle, path: row.sourcePath });
  }
  return [...groups.values()]
    .sort((left, right) => right.sources.length - left.sources.length || left.targetTitle.localeCompare(right.targetTitle))
    .slice(0, limit)
    .map((group) => ({
      id: `broken-link:${group.targetTitle}`,
      kind: 'broken-link',
      targetTitle: group.targetTitle,
      referenceCount: group.sources.length,
      sources: group.sources.filter((source) => noteById.has(source.id)),
      reason: `有 ${group.sources.length} 篇笔记引用「${group.targetTitle}」，但目标笔记尚不存在`,
      ...HIGH_CONFIDENCE_FINDING,
    }));
}

function findDuplicates(notes, limit) {
  const groups = new Map();
  for (const note of notes) {
    const titleKey = normalizeText(note.title);
    const bodyKey = exactBodyFingerprint(note.content);
    if (titleKey) addDuplicateCandidate(groups, `title:${titleKey}`, note, '标题相同');
    if (bodyKey) addDuplicateCandidate(groups, `body:${bodyKey}`, note, '正文高度一致');
  }
  const merged = new Map();
  for (const group of groups.values()) {
    if (group.notes.length < 2) continue;
    const noteIds = group.notes.map((note) => note.id).sort();
    const key = noteIds.join('|');
    if (!merged.has(key)) merged.set(key, { notes: group.notes, evidence: new Set() });
    for (const evidence of group.evidence) merged.get(key).evidence.add(evidence);
  }
  return [...merged.values()]
    .map((group) => {
      const noteIds = group.notes.map((note) => note.id).sort();
      const pairKey = noteIds.join('|');
      const evidence = [...group.evidence];
      const confidence = evidence.length > 1 ? 'high' : 'review';
      return {
        id: `duplicate:${createHash('sha1').update(pairKey).digest('hex').slice(0, 12)}`,
        kind: 'duplicate',
        noteIds,
        notes: group.notes.map((note) => noteFinding(note, { reason: evidence.join('、') })),
        evidence,
        confidence,
        status: 'open',
        severity: confidence === 'high' ? 'warning' : 'candidate',
        priority: confidence === 'high' ? 75 : 45,
        reason: confidence === 'high' ? '标题与正文都高度一致' : evidence[0],
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

function findConflicts(notes, limit) {
  const groups = new Map();
  for (const note of notes) {
    const key = normalizeText(note.title);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(note);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1 && new Set(group.map((note) => fingerprint(note.content) || note.content)).size > 1)
    .map((group) => {
      const noteIds = group.map((note) => note.id).sort();
      return {
        id: `conflict:${createHash('sha1').update(noteIds.join('|')).digest('hex').slice(0, 12)}`,
        kind: 'conflict',
        noteIds,
        notes: group.map((note) => noteFinding(note, { reason: '同名笔记正文存在差异' })),
        reason: `标题「${group[0].title}」对应多个不同版本，可能是冲突而非重复`,
        evidence: group.map((note) => ({ id: note.id, path: note.filePath, updatedAt: note.updatedAt, wordCount: note.wordCount })),
        ...REVIEW_FINDING,
      };
    })
    .slice(0, limit);
}

function findMetadataGaps(notes, propertiesById, tagMap, limit) {
  return notes.map((note) => {
    const properties = propertiesById.get(note.id) ?? {};
    const missing = [];
    if (!(tagMap.get(note.id) ?? []).length) missing.push('标签');
    if (!hasProperty(properties, ['source', '来源', 'origin'])) missing.push('来源');
    if (!isTimestamp(note.createdAt) || !isTimestamp(note.updatedAt)) missing.push('时间戳');
    if (!missing.length) return null;
    const severity = missing.includes('时间戳') || missing.includes('来源') ? 'warning' : 'candidate';
    return noteFinding(note, {
      kind: 'metadata',
      missing,
      metadata: { hasTags: !missing.includes('标签'), hasSource: !missing.includes('来源'), hasTimestamps: !missing.includes('时间戳') },
      reason: `缺少元数据：${missing.join('、')}`,
      ...(severity === 'warning' ? REVIEW_FINDING : CANDIDATE_FINDING),
    });
  }).filter(Boolean).slice(0, limit);
}

function findTaxonomyIssues(notes, propertiesById, tagMap, allTags, limit) {
  const groups = new Map();
  for (const tag of allTags) {
    const key = normalizeTaxonomy(tag.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tag);
  }
  const tagAliases = [...groups.values()].filter((group) => new Set(group.map((tag) => tag.name)).size > 1);
  const findings = tagAliases.map((group) => {
    const names = group.map((tag) => tag.name).sort((left, right) => left.localeCompare(right, 'zh-CN'));
    const affected = notes.filter((note) => (tagMap.get(note.id) ?? []).some((tag) => names.includes(tag.name)));
    return {
      id: `taxonomy:tag:${normalizeTaxonomy(names.join('|'))}`,
      kind: 'taxonomy',
      issueType: 'tag-alias',
      tags: names,
      noteIds: affected.map((note) => note.id),
      reason: `标签 ${names.map((name) => `「${name}」`).join('、')} 可能是同一概念的不同写法`,
      suggestedCanonical: [...names].sort((left, right) => left.length - right.length || left.localeCompare(right, 'zh-CN'))[0],
      ...REVIEW_FINDING,
    };
  });
  const categoryGroups = new Map();
  for (const note of notes) {
    const properties = propertiesById.get(note.id) ?? {};
    const category = properties.category ?? properties['分类'];
    if (category === undefined || category === null || String(category).trim() === '') continue;
    const key = normalizeTaxonomy(category);
    if (!categoryGroups.has(key)) categoryGroups.set(key, { variants: new Set(), noteIds: [] });
    categoryGroups.get(key).variants.add(String(category).trim());
    categoryGroups.get(key).noteIds.push(note.id);
  }
  for (const [key, group] of categoryGroups) {
    if (group.variants.size < 2) continue;
    findings.push({
      id: `taxonomy:category:${key}`,
      kind: 'taxonomy',
      issueType: 'category-alias',
      variants: [...group.variants].sort(),
      noteIds: group.noteIds,
      reason: `分类存在多个近似写法：${[...group.variants].map((value) => `「${value}」`).join('、')}`,
      ...REVIEW_FINDING,
    });
  }
  return findings.slice(0, limit);
}

function findLegacyStructureGaps(notes, propertiesById, tagMap, limit) {
  return notes.map((note) => {
    const properties = propertiesById.get(note.id) ?? {};
    const missing = [];
    if (!note.folderId) missing.push('未归入目录');
    if (!(tagMap.get(note.id) ?? []).length) missing.push('没有标签');
    if (!Object.keys(properties).some((key) => !SYSTEM_PROPERTIES.has(key))) missing.push('缺少自定义属性');
    if (!missing.length) return null;
    return noteFinding(note, { missing, reason: missing.join('、'), ...CANDIDATE_FINDING });
  }).filter(Boolean).slice(0, limit);
}

function addDuplicateCandidate(groups, key, note, evidence) {
  if (!groups.has(key)) groups.set(key, { notes: [], evidence: new Set() });
  const group = groups.get(key);
  group.notes.push(note);
  group.evidence.add(evidence);
}

function noteFinding(note, extra = {}) {
  return {
    ...CANDIDATE_FINDING,
    id: note.id,
    kind: 'note',
    title: note.title,
    path: note.filePath || `${note.title}.md`,
    folderId: note.folderId,
    updatedAt: note.updatedAt,
    wordCount: note.wordCount,
    ...extra,
  };
}

function hasProperty(properties, candidates) {
  return candidates.some((key) => {
    const value = properties[key];
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
}

function isTimestamp(value) {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function normalizeTaxonomy(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s_\-/\\]+/gu, '');
}

function fingerprint(content) {
  const normalized = normalizeText(content);
  if (normalized.length < 20) return '';
  return createHash('sha1').update(normalized).digest('hex');
}

function exactBodyFingerprint(content) {
  const normalized = normalizeText(content);
  if (normalized.length < 8) return '';
  return createHash('sha1').update(normalized).digest('hex');
}

function rankAndLimit(items, limit) {
  return [...items].sort(compareFindings).slice(0, limit);
}

function compareFindings(left, right) {
  return (right.priority ?? 0) - (left.priority ?? 0)
    || String(left.updatedAt ?? '').localeCompare(String(right.updatedAt ?? ''))
    || String(left.id).localeCompare(String(right.id));
}
