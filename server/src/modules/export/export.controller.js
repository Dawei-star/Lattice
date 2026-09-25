/** 导出控制器：HTTP 语义转换层 */
import * as service from './export.service.js';

export async function exportStaticSite(_req, res) {
  res.json({ data: service.exportStatic() });
}
