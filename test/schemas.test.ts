import { describe, it, expect } from 'vitest';
import {
  IncomingLogZ,
  CreateSourceZ,
  LogsQueryZ,
  LoginRequestZ,
  LogoutRequestZ,
  RefreshRequestZ,
  RegisterRequestZ,
  ResendOtpRequestZ,
  VerifyOtpRequestZ,
} from '../src/schemas/index.js';

describe('IncomingLogZ', () => {
  it('accepts a minimal log', () => {
    const r = IncomingLogZ.safeParse({ message: 'hello' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.severity).toBe('INFO');
      expect(r.data.ts).toBeInstanceOf(Date);
    }
  });

  it('rejects empty message', () => {
    const r = IncomingLogZ.safeParse({ message: '' });
    expect(r.success).toBe(false);
  });

  it('parses ISO and epoch ms timestamps', () => {
    const a = IncomingLogZ.parse({ message: 'x', ts: '2024-01-02T03:04:05Z' });
    const b = IncomingLogZ.parse({ message: 'x', ts: 1_700_000_000_000 });
    expect(a.ts.getTime()).toBeGreaterThan(0);
    expect(b.ts.getTime()).toBe(1_700_000_000_000);
  });
});

describe('CreateSourceZ', () => {
  it('requires uuid project id', () => {
    const r = CreateSourceZ.safeParse({ projectId: 'nope', name: 'x', type: 'pm2' });
    expect(r.success).toBe(false);
  });
});

describe('LogsQueryZ', () => {
  it('coerces query string numbers', () => {
    const r = LogsQueryZ.parse({ limit: '50', from: '1700000000000' });
    expect(r.limit).toBe(50);
    expect(r.from).toBe(1_700_000_000_000);
  });
});

describe('auth schemas', () => {
  it('rejects extra fields on register', () => {
    const r = RegisterRequestZ.safeParse({
      email: 'user@example.com',
      password: 'Str0ngPass',
      role: 'admin',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a valid otp verification payload', () => {
    const r = VerifyOtpRequestZ.parse({ email: 'user@example.com', code: '493021' });
    expect(r.code).toBe('493021');
  });

  it('rejects non-digit otp codes', () => {
    const r = VerifyOtpRequestZ.safeParse({ email: 'user@example.com', code: '49a021' });
    expect(r.success).toBe(false);
  });

  it('requires refresh token in refresh payload', () => {
    const r = RefreshRequestZ.safeParse({});
    expect(r.success).toBe(false);
  });

  it('accepts logout without a body token', () => {
    const r = LogoutRequestZ.parse({});
    expect(r.refreshToken).toBeUndefined();
  });

  it('accepts email-only resend otp payloads', () => {
    const r = ResendOtpRequestZ.parse({ email: 'user@example.com' });
    expect(r.email).toBe('user@example.com');
  });

  it('accepts login with email and password', () => {
    const r = LoginRequestZ.parse({ email: 'user@example.com', password: 'Str0ngPass' });
    expect(r.email).toBe('user@example.com');
  });
});
