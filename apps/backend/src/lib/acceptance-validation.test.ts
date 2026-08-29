import { describe, it, expect } from 'vitest';
import { cannotFail, hollowChecks, explainHollow } from './acceptance-validation.js';

describe('the check that was actually written', () => {
  it('refuses it, and says why', () => {
    const why = cannotFail("echo 'Verification done via MCP tool calls in leaf'");
    expect(why).toBeTruthy();
    expect(why).toMatch(/always exits 0/);
  });

  it('refuses the other constant-zero commands of the same family', () => {
    for (const c of ['true', ':', 'exit 0', 'printf "ok"', 'pwd', 'ls', 'sleep 5', 'cd /work']) {
      expect(cannotFail(c), c).toBeTruthy();
    }
  });

  it('refuses an empty command', () => {
    expect(cannotFail('')).toBeTruthy();
    expect(cannotFail('   ')).toBeTruthy();
  });
});

describe('the shape that hides a real command behind a passing one', () => {
  it('refuses a chain ending in echo, which swallows the failure', () => {
    const why = cannotFail('npm test && echo ok');
    expect(why).toMatch(/exits 0 even when the earlier commands fail/);
  });

  it('refuses `|| true`, which discards the failure it was meant to report', () => {
    expect(cannotFail('npm test || true')).toMatch(/discards any failure/);
    expect(cannotFail('pytest -q || :')).toBeTruthy();
  });

  it('ACCEPTS a chain whose last link can fail', () => {
    expect(cannotFail('npm ci && npm test')).toBeUndefined();
  });
});

describe('what it must not refuse', () => {
  it('accepts the commands set_acceptance asks for', () => {
    for (const c of [
      'npm test',
      'node src/cli.js "Fall City, WA"',
      'python -m pytest -q',
      'curl -sf http://github-mcp:8080/health',
      'test -s DISCOVERY.md',
      'grep -q "https://" REPORT.md',
      'go test ./...',
      'node -e "require(\'./src/server.js\')"',
    ]) {
      expect(cannotFail(c), c).toBeUndefined();
    }
  });

  it('does not refuse a command merely because the word echo appears in it', () => {
    expect(cannotFail('grep -q echo server.js')).toBeUndefined();
    expect(cannotFail('node test/echo.test.js')).toBeUndefined();
  });
});

describe('reporting a plan', () => {
  it('names every hollow check and leaves the real ones out', () => {
    const verdicts = hollowChecks([
      { name: 'suite', command: 'npm test' },
      { name: 'claim', command: "echo 'done'" },
      { name: 'swallowed', command: 'npm run build && true' },
    ]);
    expect(verdicts.map((v) => v.name)).toEqual(['claim', 'swallowed']);
  });

  it('is empty for a plan that can fail', () => {
    expect(hollowChecks([{ name: 'runs', command: 'node src/cli.js Seattle' }])).toEqual([]);
  });

  it('tells the model the SHAPE of a real check, not just that it was wrong', () => {
    const text = explainHollow(hollowChecks([{ name: 'claim', command: "echo 'done'" }]));
    expect(text).toContain('claim');
    expect(text).toContain("echo 'done'");
    expect(text).toMatch(/exit non-zero when the thing is broken/);
    expect(text).toMatch(/call the service and check the response/);
    expect(text).toMatch(/Do not append `echo`/);
  });

  it('reads correctly for one check and for several', () => {
    expect(explainHollow([{ name: 'a', command: 'true', reason: 'x' }])).toMatch(/^This check cannot fail/);
    expect(explainHollow([
      { name: 'a', command: 'true', reason: 'x' },
      { name: 'b', command: ':', reason: 'y' },
    ])).toMatch(/^These checks cannot fail/);
  });
});
