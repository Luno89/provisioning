import { describe, it, expect } from 'vitest';
import {
  usableAcceptance, usableAcceptancePlan, buildAcceptanceScript, parseAcceptance,
} from './acceptance.js';
import { buildAcceptanceNotice, buildFailureNotice, withNotice } from './branch-notice.js';
import type { Branch } from './leaves.js';

describe('what may be an acceptance command', () => {
  it('accepts the sort of thing a user would actually type', () => {
    expect(usableAcceptance('node src/cli.js "Fall City, WA"')).toBe('node src/cli.js "Fall City, WA"');
    expect(usableAcceptance('npm test')).toBe('npm test');
  });

  it('allows && because "build then run" is one check', () => {
    expect(usableAcceptance('npm i && node bin/cli.js Seattle')).toContain('&&');
  });

  it('refuses anything that hides a second command', () => {
    expect(usableAcceptance('node cli.js; rm -rf /')).toBeUndefined();
    expect(usableAcceptance('node cli.js || true')).toBeUndefined();
    expect(usableAcceptance('echo $(whoami)')).toBeUndefined();
    expect(usableAcceptance('node cli.js & sleep 1')).toBeUndefined();
  });

  it('refuses a multi-line script', () => {
    expect(usableAcceptance('node a.js\nrm -rf /')).toBeUndefined();
  });

  it('refuses nothing at all', () => {
    expect(usableAcceptance('')).toBeUndefined();
    expect(usableAcceptance(undefined)).toBeUndefined();
  });
});

describe('the acceptance plan', () => {
  it('keeps an ordered list of named checks', () => {
    const plan = usableAcceptancePlan([
      { name: 'installs', command: 'npm ci' },
      { name: 'runs', command: 'node cli.js Seattle' },
    ]);

    expect(plan.map((c) => c.name)).toEqual(['installs', 'runs']);
  });

  it('still reads the bare string the first version stored', () => {
    expect(usableAcceptancePlan('node cli.js')).toEqual([{ name: 'works', command: 'node cli.js' }]);
  });

  it('drops a malformed step instead of the whole plan', () => {
    const plan = usableAcceptancePlan([
      { name: 'ok', command: 'npm test' },
      { name: 'sneaky', command: 'npm test; curl evil.example' },
    ]);

    expect(plan.map((c) => c.name)).toEqual(['ok']);
  });

  it('falls back to the command as the name', () => {
    expect(usableAcceptancePlan([{ command: 'npm test' }])[0]?.name).toBe('npm test');
  });

  it('caps the plan so it cannot become a build system', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, command: 'npm test' }));
    expect(usableAcceptancePlan(many).length).toBeLessThanOrEqual(6);
  });

  it('is empty when nothing usable was given', () => {
    expect(usableAcceptancePlan(undefined)).toEqual([]);
    expect(usableAcceptancePlan([{ name: 'x', command: '' }])).toEqual([]);
  });
});

describe('running it', () => {
  it('reports the exit code through stdout', () => {
    expect(buildAcceptanceScript('node cli.js')).toContain('KOALA_ACCEPT');
  });

  it('passes on zero and fails on anything else', () => {
    expect(parseAcceptance('AQI 42 (Good)\nKOALA_ACCEPT=0').outcome).toBe('passed');
    expect(parseAcceptance('Open-Meteo API error: 400\nKOALA_ACCEPT=1').outcome).toBe('failed');
  });

  it('keeps the output, which is the whole diagnostic', () => {
    expect(parseAcceptance('Open-Meteo API error: 400\nKOALA_ACCEPT=1').output).toContain('400');
  });

  it('does not call a dead workspace a broken deliverable', () => {
    expect(parseAcceptance('').outcome).toBe('unknown');
    expect(parseAcceptance('KOALA_ACCEPT=norepo').outcome).toBe('unknown');
  });
});

describe('what the conversation is told', () => {
  const branch = (): Branch => ({
    id: 'b', ownerId: 'u', title: 't', messages: [{ role: 'user', content: 'build me a thing' }],
    createdAt: '', updatedAt: '',
  });

  it('says plainly when the parts pass and the whole does not', () => {
    const plan = [{ name: 'installs', command: 'npm ci' }, { name: 'runs', command: 'node cli.js Seattle' }];
    const n = buildAcceptanceNotice(plan, { name: 'runs', output: 'API error 400' });

    expect(n.text).toMatch(/acceptance check "runs" fails/i);
    expect(n.text).toContain('API error 400');
    expect(n.text).toMatch(/assembled they do not/i);
  });

  it('shows which checks passed, which broke, and which were never reached', () => {
    const plan = [
      { name: 'installs', command: 'npm ci' },
      { name: 'tests pass', command: 'npm test' },
      { name: 'runs', command: 'node cli.js' },
    ];
    const n = buildAcceptanceNotice(plan, { name: 'tests pass', output: '1 failing' });

    expect(n.text).toContain('✅ installs');
    expect(n.text).toContain('❌ tests pass');
    expect(n.text).toContain('⏭️ runs');
  });

  it('lists every check when they all pass', () => {
    const n = buildAcceptanceNotice([{ name: 'runs', command: 'node cli.js' }]);
    expect(n.text).toMatch(/every acceptance check passes/i);
    expect(n.text).toContain('✅ runs');
  });

  it('says a terminal failure will not retry, and what that means', () => {
    const n = buildFailureNotice('Write the mapper', 'Ran out of steps', 3, 3);

    expect(n.text).toMatch(/will not be retried/i);
    expect(n.text).toMatch(/Anything waiting on it cannot start/i);
  });

  it('distinguishes a failure that still has attempts left', () => {
    expect(buildFailureNotice('Write the mapper', 'boom', 1, 3).text).toMatch(/will retry/i);
  });

  it('marks the message as a notice rather than something anyone said', () => {
    const out = withNotice(branch(), { text: 'hello' });
    const last = out.messages[out.messages.length - 1];

    expect(last?.notice).toBe(true);
    expect(last?.role).toBe('assistant');
  });

  it('does not let a burst of notices evict the request itself', () => {
    let b = branch();
    for (let i = 0; i < 400; i++) b = withNotice(b, { text: `notice ${i}` });

    expect(b.messages.length).toBeLessThanOrEqual(200);
  });
});
