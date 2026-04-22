import { describe, it, expect } from 'vitest';
import { IncomingLogZ, CreateSourceZ, LogsQueryZ } from '../src/schemas/index.js';

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
