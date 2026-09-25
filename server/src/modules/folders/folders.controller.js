/**
 * 文件夹控制器：只做「解析请求 → 调用服务 → 组织响应」，不写业务逻辑。
 * 注意：Express 5 会自动捕获 async handler 抛出的异常并转交错误中间件，
 * 因此这里不需要额外的 try/catch 包装。
 */
import * as service from './folders.service.js';

export async function listFolders(_req, res) {
  res.json({ data: service.listTree() });
}

export async function createFolder(req, res) {
  const folder = service.create(req.valid.body);
  res.status(201).json({ data: folder });
}

export async function updateFolder(req, res) {
  const folder = service.update(req.valid.params.id, req.valid.body);
  res.json({ data: folder });
}

export async function deleteFolder(req, res) {
  const result = service.remove(req.valid.params.id);
  res.json({ data: result });
}
