import { describe, expect, it } from 'vitest';
import { failureOf, ignore, tokenAlreadyGone } from './failures.js';

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

describe('a fetch that never got an answer', () => {
  it('is not answering yet when the network failed it, however fetch words it', () => {
    expect(failureOf(new TypeError('Failed to fetch'))).toEqual({ kind: 'temporary', reason: 'the connection to it failed (Failed to fetch)' });
    expect(failureOf(new TypeError('fetch failed'))).toEqual({ kind: 'temporary', reason: 'the connection to it failed (fetch failed)' });
  });

  it('is final when the name it asked for does not resolve', () => {
    expect(failureOf(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })).kind).toBe('final');
  });

  it('is final, saying why, when it refused the certificate it was answered with', () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) });
    expect(failureOf(refused)).toEqual({ kind: 'final', reason: 'fetch failed: self-signed certificate in certificate chain' });
  });
});

describe('an answer an OpenID client could not read as one', () => {
  const unreadable = (status: number) => Object.assign(new Error('unexpected HTTP response status code', { cause: new Response('', { status }) }), { name: 'ClientError', code: 'OAUTH_RESPONSE_IS_NOT_CONFORM' });

  it('is not answering yet when the server or the proxy in front of it answered a server error', () => {
    expect(failureOf(unreadable(502))).toEqual({ kind: 'temporary', reason: 'it answered 502' });
    expect(failureOf(unreadable(503))).toEqual({ kind: 'temporary', reason: 'it answered 503' });
  });

  it('is final when the answer refused the request', () => {
    expect(failureOf(unreadable(403))).toEqual({ kind: 'final', reason: 'it refused the request (403)' });
  });
});

describe('a token asked to be revoked', () => {
  it('is already revoked when what holds it says it is gone or not a token it knows', () => {
    expect(tokenAlreadyGone(Object.assign(new Error('not found'), { status: 404 }))).toBe(true);
    expect(tokenAlreadyGone(Object.assign(new Error('server responded with an error in the response body'), { name: 'ResponseBodyError', status: 400, error: 'invalid_token' }))).toBe(true);
    expect(tokenAlreadyGone(Object.assign(new Error('server responded with an error in the response body'), { name: 'ResponseBodyError', status: 400, error: 'invalid_grant' }))).toBe(true);
  });

  it('is not revoked when the one asking was refused or could not ask', () => {
    expect(tokenAlreadyGone(Object.assign(new Error('server responded with an error in the response body'), { name: 'ResponseBodyError', status: 401, error: 'invalid_client' }))).toBe(false);
    expect(tokenAlreadyGone(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(false);
  });
});

describe('a final failure whose words are in its cause', () => {
  it('names every message down the cause chain, as the Temporal SDK wraps the server\'s answer', () => {
    const grpc = Object.assign(new Error('5 NOT_FOUND: namespace koala not found'), { code: 5 });
    const wrapped = Object.assign(new Error('Failed to start Workflow', { cause: grpc }), { name: 'ServiceError' });
    expect(failureOf(wrapped)).toEqual({ kind: 'final', reason: 'Failed to start Workflow: 5 NOT_FOUND: namespace koala not found' });
  });

  it('names a cause only once when the message already carries it, and stops at a cause that loops', () => {
    const inner = new Error('disk full');
    expect(failureOf(new Error('writing failed: disk full', { cause: inner })).reason).toBe('writing failed: disk full');
    const looped = new Error('outer');
    const middle = new Error('middle', { cause: looped });
    Object.assign(looped, { cause: middle });
    expect(failureOf(looped).reason).toBe('outer: middle');
  });
});

describe('ignoring a failure', () => {
  it('lets a failure go only when it says why', async () => {
    expect(await Promise.reject(new Error('gone already')).catch(ignore('the temp file may already be removed'))).toBeUndefined();
    expect(() => ignore('  ')).toThrow('say why the failure does not matter');
  });
});
