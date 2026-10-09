import * as service from './canvas.service.js';
import { requireFileConfirmation } from '../../lib/file-confirmation.js';

export async function readCanvas(_req, res) {
  res.json({ data: await service.read(_req.valid.query.path) });
}

export async function writeCanvas(req, res) {
  // 更新已有 Canvas 是正常编辑；只有通过 PUT 创建新文件时才需要确认。
  if (!service.exists(req.valid.query.path)) requireFileConfirmation(req);
  res.json({ data: await service.write(req.valid.body, req.valid.query.path) });
}

export async function listCanvasFiles(_req, res) {
  res.json({ data: service.list() });
}

export async function moveCanvas(req, res) {
  requireFileConfirmation(req);
  res.json({ data: service.move(req.valid.body.fromPath, req.valid.body.toPath) });
}

export async function deleteCanvas(req, res) {
  requireFileConfirmation(req, { destructive: true });
  res.json({ data: await service.remove(req.valid.query.path) });
}
