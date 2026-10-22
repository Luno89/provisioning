export const PLAYWRIGHT_REPORT = JSON.stringify({
  config: {},
  suites: [{
    title: 'probe.spec.ts',
    file: 'probe.spec.ts',
    specs: [
      { title: 'signs in', file: 'probe.spec.ts', tests: [{ status: 'expected', results: [{ status: 'passed', duration: 1200 }] }] },
      { title: 'sees the field', file: 'probe.spec.ts', tests: [{ status: 'unexpected', results: [{ status: 'failed', duration: 5400, error: { message: '\u001b[31mError: expect(locator).toBeVisible() failed\u001b[39m\nLocator: [name="koala_never_made"]' } }] }] },
    ],
    suites: [{
      title: 'the probe form',
      file: 'probe.spec.ts',
      specs: [
        { title: 'saves', file: 'probe.spec.ts', tests: [{ status: 'flaky', results: [{ status: 'failed', duration: 100 }, { status: 'passed', duration: 300 }] }] },
        { title: 'prints', file: 'probe.spec.ts', tests: [{ status: 'skipped', results: [{ status: 'skipped', duration: 0 }] }] },
      ],
    }],
  }],
  errors: [],
  stats: { expected: 1, unexpected: 1, flaky: 1, skipped: 1 },
});
