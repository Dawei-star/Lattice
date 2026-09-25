/**
 * 边界输入校验。所有来自客户端的 body / query / params 都必须先过 zod，
 * 校验结果写入 req.valid，业务代码只读 req.valid.*。
 * 这里刻意不改写 req.query（Express 5 中它是只读访问器）。
 */
import { ValidationError } from '../lib/errors.js';

/**
 * @param {{ body?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny }} schemas
 */
export function validate(schemas) {
  return (req, _res, next) => {
    /** @type {Record<string, unknown>} */
    const valid = { body: req.body, query: req.query, params: req.params };
    /** @type {Array<{ in: string, field: string, message: string }>} */
    const details = [];

    for (const key of ['body', 'query', 'params']) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(valid[key] ?? {});
      if (result.success) {
        valid[key] = result.data;
        continue;
      }
      for (const issue of result.error.issues) {
        details.push({
          in: key,
          field: issue.path.join('.') || '(root)',
          message: issue.message,
        });
      }
    }

    if (details.length > 0) {
      next(new ValidationError('请求参数校验未通过', details));
      return;
    }

    req.valid = valid;
    next();
  };
}
