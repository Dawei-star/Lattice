import * as health from './knowledge-health.service.js';

export function getHealth(req, res) {
  res.json({ data: health.scan(req.valid.query) });
}
