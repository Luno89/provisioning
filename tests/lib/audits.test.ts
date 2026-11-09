import { describe, expect, it } from 'vitest';
import { auditFileOf, auditOwed, auditRefusal, owedAudits, withFailure } from './audits.js';

describe('a test that fails twice', () => {
  it('owes an audit from its second failure since the last one, and not before', () => {
    expect(auditOwed(['2026-11-01T00:00:00Z'], undefined)).toBe(false);
    expect(auditOwed(['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'], undefined)).toBe(true);
    expect(auditOwed(['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'], '2026-11-01T12:00:00Z')).toBe(false);
    expect(auditOwed(['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z'], '2026-11-01T12:00:00Z')).toBe(true);
  });

  it('compares times, not text, so an audit committed with a local offset counts against failures written in UTC', () => {
    expect(auditOwed(['2026-11-09T16:11:33.750Z', '2026-11-09T16:12:42.839Z'], '2026-11-09T11:52:45-08:00')).toBe(false);
    expect(auditOwed(['2026-11-09T20:00:00.000Z', '2026-11-09T20:05:00.000Z'], '2026-11-09T11:52:45-08:00')).toBe(true);
  });

  it('keeps every failure it is told of, for each suite or file apart', () => {
    const failures = withFailure(withFailure(withFailure({}, 'routes-live', 'a'), 'routes-live', 'b'), 'src/x.test.ts', 'c');
    expect(failures).toEqual({ 'routes-live': ['a', 'b'], 'src/x.test.ts': ['c'] });
    expect(owedAudits(failures, () => undefined)).toEqual(['routes-live']);
  });

  it('names where the audit goes, and says what to do', () => {
    expect(auditFileOf('routes-live')).toBe('tests/audits/routes-live.md');
    expect(auditFileOf('apps/backend/src/extensions/grove/grove-run.integration.test.ts')).toBe('tests/audits/apps_backend_src_extensions_grove_grove-run.integration.test.ts.md');
    expect(auditRefusal([])).toBeUndefined();
    expect(auditRefusal(['routes-live'])).toContain('commit what you found as tests/audits/routes-live.md');
  });
});
