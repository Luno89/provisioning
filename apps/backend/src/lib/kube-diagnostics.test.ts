import { describe, it, expect } from 'vitest';
import { namespaceFor, logsCommand, eventsCommand, trimOutput, LOG_TAIL } from './kube-diagnostics.js';

const mine = [
  { name: 'spec-mongo', namespace: 'spec-mongo', ownerId: 'u1' },
  { name: 'Koala Store', namespace: 'koala-store', ownerId: 'u1' },
  { name: 'theirs', namespace: 'theirs', ownerId: 'u2' },
];

describe('what a caller may read', () => {
  it('resolves a deployment they own', () => {
    expect(namespaceFor('spec-mongo', mine, 'u1')).toBe('spec-mongo');
  });

  it('matches on the namespace too, since that is what logs are labelled with', () => {
    expect(namespaceFor('koala-store', mine, 'u1')).toBe('koala-store');
  });

  it('REFUSES another tenant\'s namespace', () => {
    expect(namespaceFor('theirs', mine, 'u1')).toBeUndefined();
  });

  it('refuses a namespace that is merely asserted', () => {
    for (const attempt of ['kube-system', 'default', 'gitea', '../../etc', '']) {
      expect(namespaceFor(attempt, mine, 'u1'), attempt).toBeUndefined();
    }
  });
});

describe('the commands', () => {
  it('reads only, and only from the named namespace', () => {
    for (const cmd of [logsCommand('spec-mongo'), eventsCommand('spec-mongo')]) {
      expect(cmd).toContain('-n');
      expect(cmd[cmd.indexOf('-n') + 1]).toBe('spec-mongo');
      for (const verb of ['delete', 'apply', 'patch', 'edit', 'exec', 'scale']) {
        expect(cmd, verb).not.toContain(verb);
      }
    }
  });

  it('takes an argument array, so nothing a model writes reaches a shell', () => {
    expect(Array.isArray(logsCommand('x'))).toBe(true);
    expect(logsCommand('x; rm -rf /')).toContain('x; rm -rf /');
  });

  it('bounds how much log it asks for', () => {
    expect(logsCommand('x')).toContain(String(LOG_TAIL));
  });

  it('sorts events oldest first, so the newest is last where a reader looks', () => {
    expect(eventsCommand('x')).toContain('--sort-by=.lastTimestamp');
  });
});

describe('what comes back', () => {
  it('keeps the END, where the error is', () => {
    const out = trimOutput(`${'x'.repeat(9000)}\nauth is not allowed when noauth is specified`);
    expect(out).toContain('auth is not allowed');
    expect(out.length).toBeLessThan(9000);
    expect(out).toMatch(/^…\[earlier output trimmed\]/);
  });

  it('leaves short output alone', () => {
    expect(trimOutput('  crash  ')).toBe('crash');
  });
});
