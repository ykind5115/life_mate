/**
 * HTTP 错误与响应契约（docs/04 §4、§5）
 *
 * 【为什么错误要先分类再映射状态码】
 *   直接在各 route 里 `reply.code(500)` 会让同一类错误在不同端点
 *   给出不同状态码。这里把「错误 → 错误码」集中定义一次：
 *     · 业务错误（会话不存在 / 已删除）→ 404 / 409
 *     · LLM 失败                        → 502 LLM_ERROR
 *     · LLM 超时 / 限流                 → 503 SERVICE_UNAVAILABLE / 429
 *     · 其余                            → 500 INTERNAL_ERROR
 *
 * 【不向用户暴露的东西】（docs/04 §44、§49）
 *   API Key、供应商原始错误、堆栈、内部地址。
 *   这些在响应里一律替换成固定文案，细节只进服务端日志。
 */

/** docs/04 §5 的错误码。取值即响应里的 error.code */
export const ERROR_CODES = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  LLM_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * 带 HTTP 语义的应用错误。
 *
 * route 层只管 throw，序列化由统一的 errorHandler 做 ——
 * 这样「返回给客户端的形状」只有一处定义。
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** 附加细节。**不得包含正文、密钥或内部地址** */
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = ERROR_CODES[code];
    if (details !== undefined) this.details = details;
  }
}

// ---------- 便于调用的构造器 ----------

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError('BAD_REQUEST', message, details);

export const notFound = (message: string): HttpError => new HttpError('NOT_FOUND', message);

export const conflict = (message: string, details?: unknown): HttpError =>
  new HttpError('CONFLICT', message, details);

export const validationError = (message: string, details?: unknown): HttpError =>
  new HttpError('VALIDATION_ERROR', message, details);

export const llmError = (message = 'AI 服务暂时不可用'): HttpError =>
  new HttpError('LLM_ERROR', message);

export const serviceUnavailable = (message = '服务暂不可用'): HttpError =>
  new HttpError('SERVICE_UNAVAILABLE', message);

export const internalError = (): HttpError =>
  new HttpError('INTERNAL_ERROR', '服务内部错误');

// ---------- 响应包装（docs/04 §4）----------

export interface SuccessResponse<T> {
  success: true;
  data: T;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export function ok<T>(data: T): SuccessResponse<T> {
  return { success: true, data };
}

/**
 * 分页响应体（docs/04 §8）。
 *
 * ⚠️ API 用 page / page_size，仓库层用 limit / offset。
 *    转换只在这里做一次 —— 两边混用会让「第 3 页」这种语义渗进 SQL。
 */
export interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export function paginate(params: {
  page: number;
  pageSize: number;
  total: number;
}): Pagination {
  return {
    page: params.page,
    page_size: params.pageSize,
    total: params.total,
    // total=0 时 total_pages 为 0 而不是 1：前端据此区分「没有数据」与「有 1 页」
    total_pages: Math.ceil(params.total / params.pageSize),
  };
}

/** page/page_size 转 offset */
export function toOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}
