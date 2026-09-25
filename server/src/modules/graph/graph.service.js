/**
 * 关系图谱读模型。
 *
 * 图谱不是独立实体，而是笔记与链接的投影视图，因此本模块不设独立仓储层，
 * 直接组合 notes / links 两个仓储的查询结果，避免再维护一份可能不一致的数据。
 */
import * as linksService from '../links/links.service.js';
import * as notesRepository from '../notes/notes.repository.js';

/**
 * 构建图谱数据：节点为笔记，边为已解析的双向链接。
 * degree（度数 = 出链 + 入链）交给前端做节点大小映射。
 */
export function buildGraph() {
  const notes = notesRepository.listBrief();
  const noteIds = notes.map((note) => note.id);

  const { outgoing, incoming } = linksService.countsForNotes(noteIds);
  const existing = new Set(noteIds);

  const nodes = notes.map((note) => ({
    id: note.id,
    title: note.title,
    folderId: note.folderId,
    isPinned: note.isPinned,
    wordCount: note.wordCount,
    degree: (outgoing.get(note.id) ?? 0) + (incoming.get(note.id) ?? 0),
  }));

  // 双保险：过滤掉端点不存在的边，保证前端拿到的图一定自洽
  const edges = linksService
    .edges()
    .filter((edge) => existing.has(edge.source) && existing.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target }));

  return {
    nodes,
    edges,
    dangling: linksService.listDangling(),
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      isolatedCount: nodes.filter((node) => node.degree === 0).length,
    },
  };
}
