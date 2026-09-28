import * as service from './canvas.service.js';

export async function readCanvas(_req, res) {
  res.json({ data: service.read(_req.valid.query.path) });
}

export async function writeCanvas(req, res) {
  res.json({ data: service.write(req.valid.body, req.valid.query.path) });
}

export async function listCanvasFiles(_req, res) {
  res.json({ data: service.list() });
}

export async function moveCanvas(req, res) {
  res.json({ data: service.move(req.valid.body.fromPath, req.valid.body.toPath) });
}
