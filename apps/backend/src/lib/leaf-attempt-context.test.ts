import { describe, it, expect } from 'vitest';
import { buildAttemptContext } from './leaf-attempt-context.js';

describe('buildAttemptContext', () => {
  it('includes the task title', () => {
    expect(buildAttemptContext({ title: 'Do the thing' }, [])).toBe('Task: Do the thing');
  });

  it('includes the body when present', () => {
    const out = buildAttemptContext({ title: 'Do the thing', body: 'Details here.' }, []);
    expect(out).toBe('Task: Do the thing\n\nDetails here.');
  });

  it('omits the body when absent', () => {
    const out = buildAttemptContext({ title: 'Do the thing', body: '' }, []);
    expect(out).toBe('Task: Do the thing');
  });

  it('appends prior-failure context when attempts exist', () => {
    const out = buildAttemptContext({ title: 'Do the thing' }, [
      { attempt: 0, error: 'boom', failedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(out).toContain('Task: Do the thing');
    expect(out).toContain('attempted 1 time(s) before and failed');
    expect(out).toContain('Attempt 1 failed: boom');
  });
});
