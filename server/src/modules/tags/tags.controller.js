/** 标签控制器 */
import * as service from './tags.service.js';

export async function listTags(_req, res) {
  res.json({ data: service.list() });
}

export async function deleteTag(req, res) {
  res.json({ data: service.remove(req.valid.params.id) });
}
