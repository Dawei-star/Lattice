/** 笔记控制器：HTTP 语义转换层，不含业务逻辑 */
import * as service from './notes.service.js';
import * as templates from './notes.templates.js';

export async function listNotes(req, res) {
  const { folderId, tagId, sort, limit, offset } = req.valid.query;
  const result = service.list({ folderId, tagId, sort, limit, offset });
  res.json({ data: result.items, meta: { total: result.total, limit, offset } });
}

export async function getNoteIndex(_req, res) {
  res.json({ data: service.index() });
}

export async function getNote(req, res) {
  res.json({ data: service.getDetail(req.valid.params.id) });
}

export async function createNote(req, res) {
  const note = service.create(req.valid.body);
  res.status(201).json({ data: note });
}

export async function duplicateNote(req, res) {
  const note = service.duplicate(req.valid.params.id, req.valid.body);
  res.status(201).json({ data: note });
}

export async function updateNote(req, res) {
  const note = service.update(req.valid.params.id, req.valid.body);
  res.json({ data: note });
}

export async function deleteNote(req, res) {
  res.json({ data: service.remove(req.valid.params.id) });
}

export async function listHistory(req, res) {
  res.json({ data: service.listHistory(req.valid.params.id) });
}

export async function getHistoryVersion(req, res) {
  res.json({ data: service.getHistoryVersion(req.valid.params.id, req.valid.params.version) });
}

export async function restoreHistory(req, res) {
  const note = service.restoreHistory(req.valid.params.id, req.valid.params.version, req.valid.body);
  res.json({ data: note });
}

export async function listTemplates(_req, res) {
  res.json({ data: templates.listTemplates() });
}

export async function createFromTemplate(req, res) {
  const note = templates.createFromTemplate(req.valid.body);
  res.status(201).json({ data: note });
}

export async function createDailyNote(req, res) {
  const note = await templates.createDaily(req.valid.body);
  res.status(201).json({ data: note });
}
