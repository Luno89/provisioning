/**
 * A five-leaf plan delivered a CLI that printed its own name and exited, with every leaf succeeded,
 * verified and merged. Nothing was wrong with the leaf checks — no leaf's job was the WHOLE, so
 * nothing ever ran the thing the user asked for.
 */
import { describe, it, expect } from 'vitest';
import { usableAcceptance, buildAcceptanceScript, parseAcceptance } from './acceptance.js';
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
    /**
     * The whole value of showing this to a human before they accept is that what they read is all
     * of what runs.
     */
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

describe('running it', () => {
  it('reports the exit code through stdout', () => {
    // A pipe to tail would swallow it, and the exit status is the verdict.
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
    // The exact case: individually green leaves, an assembled thing that does not work.
    const n = buildAcceptanceNotice('node cli.js Seattle', false, 'API error 400');

    expect(n.text).toMatch(/acceptance check fails/i);
    expect(n.text).toContain('API error 400');
    expect(n.text).toMatch(/assembled they do not/i);
  });

  it('says a terminal failure will not retry, and what that means', () => {
    // Otherwise the dependents sit `pending`, looking like work that has not started yet.
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
    // A ten-leaf plan failing ten times must not push the original ask out of its own transcript.
    let b = branch();
    for (let i = 0; i < 400; i++) b = withNotice(b, { text: `notice ${i}` });

    expect(b.messages.length).toBeLessThanOrEqual(200);
  });
});
