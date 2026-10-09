import { ValidationError } from './errors.js';

/** HTTP 写入口的统一确认闸门；预览与 UI 卡片在调用方完成，服务端负责拒绝无确认请求。 */
export function requireFileConfirmation(req, { destructive = false } = {}) {
  const body = req.valid?.body && !Buffer.isBuffer(req.valid.body) ? req.valid.body : {};
  const query = req.valid?.query ?? {};
  const source = { ...query, ...body };
  if (body.confirmed !== true && query.confirmed !== true) {
    throw new ValidationError('文件变更必须先完成确认卡片');
  }
  if (destructive && body.secondConfirmed !== true && query.secondConfirmed !== true) {
    throw new ValidationError('删除操作必须完成二次确认');
  }
  return {
    ...source,
    confirmed: body.confirmed === true || query.confirmed === true,
    secondConfirmed: body.secondConfirmed === true || query.secondConfirmed === true,
  };
}
