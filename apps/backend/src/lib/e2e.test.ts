import { describe, it, expect } from 'vitest';
import { PLAYWRIGHT_REPORT } from './e2e-fixtures.js';
import { e2eCommand, e2ePassed, e2eRequestOf, e2eSummary, e2eUrlProblem, readE2EReport } from './e2e.js';

describe('what a browser test check asks for', () => {
  it('reads specs as a list, a string or nothing, defaulting to the e2e folder', () => {
    expect(e2eRequestOf({ specs: ['e2e/a.spec.ts', ' '] })).toEqual({ specs: ['e2e/a.spec.ts'] });
    expect(e2eRequestOf({ specs: 'e2e/a.spec.ts, e2e/b.spec.ts' })).toEqual({ specs: ['e2e/a.spec.ts', 'e2e/b.spec.ts'] });
    expect(e2eRequestOf(['e2e/a.spec.ts'])).toEqual({ specs: ['e2e/a.spec.ts'] });
    expect(e2eRequestOf(true)).toEqual({ specs: ['e2e'] });
    expect(e2eRequestOf({})).toEqual({ specs: ['e2e'] });
    expect(e2eRequestOf(7)).toBeUndefined();
  });

  it('takes an address only when a browser can open it and it carries no login', () => {
    expect(e2eRequestOf({ specs: ['e2e'], url: 'http://shop.local:8069' })).toEqual({ specs: ['e2e'], url: 'http://shop.local:8069' });
    expect(e2eRequestOf({ url: 'https://admin:secret@shop.example' })).toBeUndefined();
    expect(e2eUrlProblem('https://admin:secret@shop.example')).toBe('a browser test address cannot carry a login: the workspace\'s agent could read it');
    expect(e2eUrlProblem('ftp://shop.example')).toBe('"ftp://shop.example" has to be an http or https address');
    expect(e2eUrlProblem('not a url')).toBe('"not a url" is not an address a browser can open');
  });
});

describe('the command a browser test check runs', () => {
  it('asks the workspace image to serve its own app, starting from clean results', () => {
    expect(e2eCommand({ specs: ['e2e/it\'s.spec.ts'] })).toBe(`rm -rf e2e-results && mkdir -p e2e-results && koala-e2e 'e2e/it'\\''s.spec.ts'`);
  });

  it('runs Playwright straight at an address, saying so when there is no Playwright', () => {
    const command = e2eCommand({ specs: ['e2e'], url: 'http://shop.local' });
    expect(command.startsWith('command -v playwright >/dev/null || exit 127;')).toBe(true);
    expect(command).toContain(`BASE_URL='http://shop.local' PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/e2e-results/report.json" playwright test 'e2e' --reporter=line,json --output="$PWD/e2e-results/artifacts"`);
  });
});

describe('reading what Playwright reported', () => {
  it('gives each test with its describe path, status, time and the reason it failed', () => {
    const report = readE2EReport(PLAYWRIGHT_REPORT)!;
    expect(report.tests).toEqual([
      { title: 'signs in', file: 'probe.spec.ts', status: 'passed', durationMs: 1200 },
      { title: 'sees the field', file: 'probe.spec.ts', status: 'failed', durationMs: 5400, error: 'Error: expect(locator).toBeVisible() failed\nLocator: [name="koala_never_made"]' },
      { title: 'the probe form › saves', file: 'probe.spec.ts', status: 'flaky', durationMs: 400 },
      { title: 'the probe form › prints', file: 'probe.spec.ts', status: 'skipped', durationMs: 0 },
    ]);
    expect(report).toMatchObject({ passed: 1, failed: 1, flaky: 1, skipped: 1, errors: [] });
    expect(e2eSummary(report)).toBe('1 passed, 1 failed, 1 flaky, 1 skipped');
    expect(e2ePassed(report)).toBe(false);
  });

  it('passes only when something ran and nothing failed', () => {
    expect(e2ePassed(readE2EReport(JSON.stringify({ suites: [], errors: [] }))!)).toBe(false);
    expect(e2eSummary(readE2EReport(JSON.stringify({ suites: [] }))!)).toBe('0 passed, 0 failed, no tests ran');
    const errored = readE2EReport(JSON.stringify({ suites: [], errors: [{ message: 'Error: No tests found' }] }))!;
    expect(errored.errors).toEqual(['Error: No tests found']);
  });

  it('has no report from nothing, or from what is not JSON', () => {
    expect(readE2EReport(undefined)).toBeUndefined();
    expect(readE2EReport('')).toBeUndefined();
    expect(readE2EReport('{ half')).toBeUndefined();
  });
});
