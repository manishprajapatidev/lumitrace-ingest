/**
 * Typed application errors. Routes catch these and translate to HTTP
 * responses; anything else is a 500.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, statusCode: number, code: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  badRequest: (msg: string, details?: unknown): AppError => new AppError(msg, 400, 'BAD_REQUEST', details),
  unauthorized: (msg = 'Unauthorized'): AppError => new AppError(msg, 401, 'UNAUTHORIZED'),
  forbidden: (msg = 'Forbidden'): AppError => new AppError(msg, 403, 'FORBIDDEN'),
  notFound: (msg = 'Not found'): AppError => new AppError(msg, 404, 'NOT_FOUND'),
  conflict: (msg: string): AppError => new AppError(msg, 409, 'CONFLICT'),
  payloadTooLarge: (msg: string): AppError => new AppError(msg, 413, 'PAYLOAD_TOO_LARGE'),
  rateLimited: (msg = 'Too many requests'): AppError => new AppError(msg, 429, 'RATE_LIMITED'),
  internal: (msg = 'Internal server error'): AppError => new AppError(msg, 500, 'INTERNAL'),
};
