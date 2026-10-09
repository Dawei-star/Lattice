/** 笔记控制器：HTTP 语义转换层，不含业务逻辑 */
import * as service from './notes.service.js';
import * as templates from './notes.templates.js';
import { requireFileConfirmation } from '../../lib/file-confirmation.js';

export async function listNotes(req, res) {
  const { folderId, tagId, inboxStatus, sort, limit, offset } = req.valid.query;
  const result = service.list({ folderId, tagId, inboxStatus, sort, limit, offset });
  res.json({ data: result.items, meta: { total: result.total, limit, offset } });
}

export async function getNoteIndex(_req, res) {
  res.json({ data: service.index() });
}

export async function getNote(req, res) {
  res.json({ data: service.getDetail(req.valid.params.id) });
}

export async function createNote(req, res) {
  requireFileConfirmation(req);
  const note = service.create(req.valid.body);
  res.status(201).json({ data: note });
}

export async function duplicateNote(req, res) {
  requireFileConfirmation(req);
  const note = service.duplicate(req.valid.params.id, req.valid.body);
  res.status(201).json({ data: note });
}

export async function updateNote(req, res) {
  // 正文、属性和置顶状态是正常编辑；标题或目录会改变 Markdown 路径，
  // 必须继续经过高风险的重命名/移动确认。
  if (req.valid.body.title !== undefined || req.valid.body.folderId !== undefined) {
    requireFileConfirmation(req);
  }
  const note = service.update(req.valid.params.id, req.valid.body);
  res.json({ data: note });
}

export async function deleteNote(req, res) {
  requireFileConfirmation(req, { destructive: true });
  res.json({ data: service.remove(req.valid.params.id) });
}

export async function listHistory(req, res) {
  res.json({ data: service.listHistory(req.valid.params.id) });
}

export async function getHistoryVersion(req, res) {
  res.json({ data: service.getHistoryVersion(req.valid.params.id, req.valid.params.version) });
}

export async function restoreHistory(req, res) {
  requireFileConfirmation(req);
  const note = service.restoreHistory(req.valid.params.id, req.valid.params.version, req.valid.body);
  res.json({ data: note });
}

export async function listTemplates(_req, res) {
  res.json({ data: templates.listTemplates() });
}

export async function createFromTemplate(req, res) {
  requireFileConfirmation(req);
  const note = templates.createFromTemplate(req.valid.body);
  res.status(201).json({ data: note });
}

export async function createDailyNote(req, res) {
  requireFileConfirmation(req);
  const note = await templates.createDaily(req.valid.body);
  res.status(201).json({ data: note });
}
