import { describe, expect, it } from 'vitest';
import { failureOf, ignore } from './failures.js';

describe('a service that listens on a socket file', () => {
  it('is not answering yet, rather than gone for good, while the file it will listen on is not there', () => {
    const socket = '/run/caddy-admin/admin.sock';
    const err = Object.assign(new Error(`connect ENOENT ${socket}`), { errno: -2, code: 'ENOENT', syscall: 'connect', address: socket });
    expect(failureOf(err)).toEqual({ kind: 'temporary', reason: `nothing listens on ${socket} yet (ENOENT)` });
    expect(failureOf(new Error('asking failed', { cause: err }))).toEqual({ kind: 'temporary', reason: `nothing listens on ${socket} yet (ENOENT)` });
  });

  it('keeps a missing file that was never a connection final', () => {
    expect(failureOf(Object.assign(new Error('no such file'), { code: 'ENOENT', syscall: 'open', path: '/nope' })).kind).toBe('final');
  });
});

describe('ignoring a failure', () => {
  it('lets a failure go only when it says why', async () => {
    expect(await Promise.reject(new Error('gone already')).catch(ignore('the temp file may already be removed'))).toBeUndefined();
    expect(() => ignore('  ')).toThrow('say why the failure does not matter');
  });
});
