import * as service from './canvas.service.js';

export async function readCanvas(_req, res) {
  res.json({ data: service.read() });
}

export async function writeCanvas(req, res) {
  res.json({ data: service.write(req.valid.body) });
}
