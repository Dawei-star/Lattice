/** 更新检查控制器 */
import * as service from './update.service.js';

export async function checkUpdate(req, res) {
  res.json({ data: await service.checkUpdate(String(req.query.current ?? '')) });
}
