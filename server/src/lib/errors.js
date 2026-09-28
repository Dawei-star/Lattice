/**
 * 类型化错误体系。
 * 业务层只抛这些错误，HTTP 状态码与客户端可见的错误码在此统一约定，
 * 由全局错误处理中间件翻译为规范化的响应体，绝不把堆栈或内部细节暴露给客户端。
 */

export class AppError extends Error {
  /**
   * @param {string} message 面向用户的错误描述
   * @param {{ status?: number, code?: string, details?: unknown, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status ?? 500;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.details = options.details;
    /** 标记为可预期错误：只记 warn，不打 error 级堆栈 */
    this.expected = true;
    Error.captureStackTrace?.(this, new.target);
  }

  toResponseBody(requestId) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
        requestId,
      },
    };
  }
}

/** 400 —— 请求本身不合法（如 JSON 解析失败） */
export class BadRequestError extends AppError {
  constructor(message = '请求格式不正确', options = {}) {
    super(message, { status: 400, code: 'BAD_REQUEST', ...options });
  }
}

/** 422 —— 字段校验未通过，details 携带逐字段说明 */
export class ValidationError extends AppError {
  constructor(message = '请求参数校验未通过', details) {
    super(message, { status: 422, code: 'VALIDATION_ERROR', details });
  }
}

/** 401 —— AI 工作区令牌缺失或无效 */
export class UnauthorizedError extends AppError {
  constructor(message = '需要有效的访问令牌', options = {}) {
    super(message, { status: 401, code: 'UNAUTHORIZED', ...options });
  }
}

/** 404 —— 资源不存在 */
export class NotFoundError extends AppError {
  constructor(message = '资源不存在', options = {}) {
    super(message, { status: 404, code: 'NOT_FOUND', ...options });
  }
}

/** 409 —— 与现有数据冲突（如重名） */
export class ConflictError extends AppError {
  constructor(message = '资源已存在', options = {}) {
    super(message, { status: 409, code: 'CONFLICT', ...options });
  }
}

/** 500 —— 明确的内部故障（保留给预期外的编程错误使用） */
export class InternalError extends AppError {
  constructor(message = '服务器内部错误', options = {}) {
    super(message, { status: 500, code: 'INTERNAL_ERROR', ...options });
    this.expected = false;
  }
}
