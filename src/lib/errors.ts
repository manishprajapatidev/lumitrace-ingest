/**
 * Typed application errors. Routes catch these and translate to HTTP
 * responses; anything else is a 500.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly headers?: Readonly<Record<string, string>>;
  public readonly body?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    details?: unknown,
    headers?: Readonly<Record<string, string>>,
    body?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.headers = headers;
    this.body = body;
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
  emailTaken: (): AppError => new AppError('email already registered', 409, 'EMAIL_TAKEN'),
  weakPassword: (): AppError => new AppError('password does not meet complexity requirements', 400, 'WEAK_PASSWORD'),
  invalidOtp: (): AppError => new AppError('invalid otp code', 400, 'INVALID_OTP'),
  otpExpired: (): AppError => new AppError('otp code expired', 410, 'OTP_EXPIRED'),
  tooManyAttempts: (): AppError => new AppError('too many otp attempts', 423, 'TOO_MANY_ATTEMPTS'),
  cooldownActive: (retryAfterSec: number): AppError =>
    new AppError(
      'otp resend cooldown active',
      429,
      'COOLDOWN_ACTIVE',
      undefined,
      { 'Retry-After': String(retryAfterSec) },
    ),
  invalidCredentials: (): AppError => new AppError('invalid email or password', 401, 'INVALID_CREDENTIALS'),
  emailNotVerified: (otpSent: boolean): AppError =>
    new AppError('email not verified', 403, 'EMAIL_NOT_VERIFIED', undefined, undefined, { otpSent }),
  invalidRefresh: (): AppError => new AppError('invalid refresh token', 401, 'INVALID_REFRESH'),
};
