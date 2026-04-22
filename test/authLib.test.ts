import { describe, expect, it } from 'vitest';
import { assertStrongPassword, generateOtpCode, normalizeEmail } from '../src/lib/auth.js';
import { AppError } from '../src/lib/errors.js';

describe('auth helpers', () => {
  it('normalizes email casing and whitespace', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
  });

  it('generates a six-digit otp', () => {
    const code = generateOtpCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('rejects weak passwords', () => {
    expect(() => assertStrongPassword('password')).toThrow(AppError);
  });

  it('accepts strong passwords', () => {
    expect(() => assertStrongPassword('Str0ngPass')).not.toThrow();
  });
});
