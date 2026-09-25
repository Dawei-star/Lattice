/** 元信息控制器 */
import * as service from './meta.service.js';

export async function getOverview(_req, res) {
  res.json({ data: service.overview() });
}
