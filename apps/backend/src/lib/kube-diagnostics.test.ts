import { describe, it, expect } from 'vitest';
import { namespaceFor, logsCommand, eventsCommand, trimOutput, LOG_TAIL } from './kube-diagnostics.js';

/**
 * Reading why a deployment is not working.
 *
 * ── THE GUESS THIS REPLACES ──
 * Asked what was broken, Koala found a crash-looping MongoDB and said the cause was "insufficient
 * memory or a missing persistent volume". Plausible, and wrong — the real reason was in the pod's
 * own output: `auth is not allowed when noauth is specified`. It never saw that, because
 * `healthReason` comes from an HTTP probe that only runs for MCP servers.
 */

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
    /**
     * The security, and it is not in Kubernetes. Pod logs contain whatever an app printed at
     * startup, which is routinely a connection string or a token.
     */
    expect(namespaceFor('theirs', mine, 'u1')).toBeUndefined();
  });

  it('refuses a namespace that is merely asserted', () => {
    // Taken from the argument rather than resolved, this would read every namespace on the cluster.
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
      // Nothing that writes. A tool that could patch or delete is a cluster-admin credential
      // handed to a language model.
      for (const verb of ['delete', 'apply', 'patch', 'edit', 'exec', 'scale']) {
        expect(cmd, verb).not.toContain(verb);
      }
    }
  });

  it('takes an argument array, so nothing a model writes reaches a shell', () => {
    expect(Array.isArray(logsCommand('x'))).toBe(true);
    expect(logsCommand('x; rm -rf /')).toContain('x; rm -rf /');
    // The dangerous string is one argument to kubectl, not shell syntax — it resolves to nothing.
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
