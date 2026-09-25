/** 搜索控制器 */
import * as service from './search.service.js';

export async function searchNotes(req, res) {
  const { q, limit } = req.valid.query;
  const result = service.search(q, limit);
  res.json({ data: result.items, meta: { query: q, strategy: result.strategy, count: result.items.length } });
}
