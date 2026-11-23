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

describe('a cluster command that kubectl could not carry out', () => {
  const kubectlSaid = (stderr: string) => Object.assign(new Error(stderr), { name: 'ClusterCommandFailed', result: { code: 1, stdout: '', stderr } });

  it('is not answering yet while its API server refuses or cannot be reached', () => {
    const refused = 'The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?';
    expect(failureOf(kubectlSaid(refused))).toEqual({ kind: 'temporary', reason: `the cluster cannot be reached: ${refused}` });
    const unreachable = 'Unable to connect to the server: dial tcp 10.0.0.4:6443: connect: connection refused';
    expect(failureOf(kubectlSaid(unreachable))).toEqual({ kind: 'temporary', reason: `the cluster cannot be reached: ${unreachable}` });
    expect(failureOf(Object.assign(new Error('Command failed: kubectl (exit 1)'), { stderr: `${unreachable}\n` })).kind).toBe('temporary');
  });

  it('is final when what it names is not there or it may not ask', () => {
    const gone = 'Error from server (NotFound): namespaces "app-1" not found';
    expect(failureOf(kubectlSaid(gone))).toEqual({ kind: 'final', reason: gone });
    const forbidden = 'Error from server (Forbidden): jobs.batch is forbidden: User "koala" cannot list resource "jobs"';
    expect(failureOf(kubectlSaid(forbidden))).toEqual({ kind: 'final', reason: forbidden });
  });
});

describe('ignoring a failure', () => {
  it('lets a failure go only when it says why', async () => {
    expect(await Promise.reject(new Error('gone already')).catch(ignore('the temp file may already be removed'))).toBeUndefined();
    expect(() => ignore('  ')).toThrow('say why the failure does not matter');
  });
});
