/** 附件控制器：HTTP 语义转换层 */
import * as service from './attachments.service.js';

export async function uploadAttachment(req, res) {
  const attachment = service.upload(req.valid.body);
  res.status(201).json({ data: attachment });
}

export async function listAttachments(_req, res) {
  res.json({ data: service.list() });
}

export async function cleanupAttachments(_req, res) {
  res.json({ data: service.cleanupOrphans() });
}

export async function deleteAttachment(req, res) {
  res.json({ data: service.remove(req.valid.params.id) });
}
