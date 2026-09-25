/** 版本历史控制器：HTTP 语义转换层，不含业务逻辑 */
import * as service from './versions.service.js';

export async function listVersions(req, res) {
  res.json({ data: service.listForNote(req.valid.params.id) });
}

export async function getVersion(req, res) {
  const { id, versionId } = req.valid.params;
  res.json({ data: service.getVersion(id, versionId) });
}

export async function restoreVersion(req, res) {
  const { id, versionId } = req.valid.params;
  res.json({ data: service.restore(id, versionId) });
}
