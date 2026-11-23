import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DEPENDENCIES, dependenciesOf, downAcross, failureOf, reportingFetch, statusFailure, stillDown, type DependencyReporter } from './dependencies.js';
import type { BackendSettings, ClusterWorkerSettings, EngineWorkerSettings, HostWorkerSettings } from './settings.js';

const coded = (code: string, message = code): Error => Object.assign(new Error(message), { code });
const fetchFailed = (code: string): Error => Object.assign(new TypeError('fetch failed'), { cause: { code } });

describe('failureOf', () => {
  it('takes a lost connection as temporary, by its code or its cause\'s, saying what happened', () => {
    expect(failureOf(fetchFailed('ECONNREFUSED'))).toEqual({ kind: 'temporary', reason: 'it refused the connection (ECONNREFUSED)' });
    expect(failureOf(coded('ECONNRESET'))).toEqual({ kind: 'temporary', reason: 'the connection to it was cut off (ECONNRESET)' });
    expect(failureOf(fetchFailed('UND_ERR_SOCKET'))).toEqual({ kind: 'temporary', reason: 'the connection to it was cut off (UND_ERR_SOCKET)' });
    expect(failureOf(coded('EHOSTUNREACH'))).toEqual({ kind: 'temporary', reason: 'its network cannot be reached (EHOSTUNREACH)' });
    expect(failureOf(coded('ETIMEDOUT'))).toEqual({ kind: 'temporary', reason: 'it did not answer in time (ETIMEDOUT)' });
    expect(failureOf(coded('ECONNABORTED'))).toEqual({ kind: 'temporary', reason: 'it did not answer in time (ECONNABORTED)' });
    expect(failureOf(coded('EAI_AGAIN'))).toEqual({ kind: 'temporary', reason: 'its name could not be looked up just now (EAI_AGAIN)' });
    expect(failureOf(Object.assign(new TypeError('terminated'), {}))).toEqual({ kind: 'temporary', reason: 'the connection to it was cut off while it answered' });
  });

  it('takes a name that does not resolve as final, as the mail check reads DNS', () => {
    for (const code of ['ENOTFOUND', 'ENODATA', 'NXDOMAIN']) expect(failureOf(fetchFailed(code))).toEqual({ kind: 'final', reason: `its name does not resolve (${code})` });
  });

  it('takes 5xx and 429 as temporary, with Retry-After when given, and any other refusal as final', () => {
    expect(statusFailure(503)).toEqual({ kind: 'temporary', reason: 'it answered 503' });
    expect(statusFailure(429, '30')).toEqual({ kind: 'temporary', reason: 'it is busy and answered 429, asking to be asked again after 30' });
    expect(statusFailure(400)).toEqual({ kind: 'final', reason: 'it refused the request (400)' });
    expect(statusFailure(404)).toEqual({ kind: 'final', reason: 'it says what was asked for is gone (404)' });
    expect(statusFailure(410)).toEqual({ kind: 'final', reason: 'it says what was asked for is gone (410)' });
    expect(failureOf(Object.assign(new Error('nope'), { response: { status: 502 } }))).toEqual({ kind: 'temporary', reason: 'it answered 502' });
    expect(failureOf(Object.assign(new Error('nope'), { response: { status: 403 } }))).toEqual({ kind: 'final', reason: 'it refused the request (403)' });
    expect(failureOf(Object.assign(new Error('the hub answered 500'), { status: 500 }))).toEqual({ kind: 'temporary', reason: 'it answered 500' });
  });

  it('takes root refusing a token as final and root not being reached as temporary, as signing in through root does', () => {
    expect(failureOf(Object.assign(new Error('invalid_grant'), { name: 'ResponseBodyError', status: 400 }))).toEqual({ kind: 'final', reason: 'it refused: invalid_grant' });
    expect(failureOf(Object.assign(new Error('invalid_grant'), { name: 'ResponseBodyError', status: 500 }))).toEqual({ kind: 'final', reason: 'it refused: invalid_grant' });
    expect(failureOf(fetchFailed('ECONNREFUSED')).kind).toBe('temporary');
  });

  it('takes Temporal unavailable or slow as temporary, and its other answers as final', () => {
    expect(failureOf(Object.assign(new Error('14 UNAVAILABLE: no connection'), { code: 14 }))).toEqual({ kind: 'temporary', reason: 'it is unavailable: 14 UNAVAILABLE: no connection' });
    expect(failureOf(Object.assign(new Error('Failed'), { name: 'ServiceError', cause: { code: 4 } }))).toEqual({ kind: 'temporary', reason: 'it did not answer in time: Failed' });
    expect(failureOf(Object.assign(new Error('workflow not found'), { name: 'WorkflowNotFoundError' }))).toEqual({ kind: 'final', reason: 'workflow not found' });
    expect(failureOf(Object.assign(new Error('tonic'), { name: 'TransportError' })).kind).toBe('temporary');
    expect(failureOf(new Error('Failed to connect before the deadline'))).toEqual({ kind: 'temporary', reason: 'its connection did not open yet: Failed to connect before the deadline' });
  });

  it('takes Mongo\'s network errors as temporary and its other errors as final', () => {
    expect(failureOf(Object.assign(new Error('connect ECONNREFUSED'), { name: 'MongoNetworkError' }))).toEqual({ kind: 'temporary', reason: 'it cannot be reached: connect ECONNREFUSED' });
    expect(failureOf(Object.assign(new Error('timed out'), { name: 'MongoServerSelectionError' })).kind).toBe('temporary');
    expect(failureOf(Object.assign(new Error('E11000 duplicate key'), { name: 'MongoServerError', code: 11000 })).kind).toBe('final');
  });

  it('takes MinIO busy or failing as temporary and its refusals as final', () => {
    expect(failureOf(Object.assign(new Error('slow down'), { name: 'S3Error', code: 'SlowDown' }))).toEqual({ kind: 'temporary', reason: 'it answered SlowDown' });
    expect(failureOf(Object.assign(new Error('denied'), { name: 'S3Error', code: 'AccessDenied' }))).toEqual({ kind: 'final', reason: 'denied' });
  });

  it('takes a dependency a reporter already judged down as temporary, in its own words', () => {
    expect(failureOf(stillDown('it closed the connection'))).toEqual({ kind: 'temporary', reason: 'it closed the connection' });
  });

  it('takes anything else as final, so a mistake in the caller never marks a dependency down', () => {
    expect(failureOf(new Error('Cannot read properties of undefined'))).toEqual({ kind: 'final', reason: 'Cannot read properties of undefined' });
    expect(failureOf(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind).toBe('final');
  });
});

describe('reportingFetch', () => {
  it('reports an answer, a failing answer and a failed connection, and hands the caller what fetch did', async () => {
    const reporter = mock<DependencyReporter>();
    const ok = new Response('ok', { status: 200 });
    const busy = new Response('', { status: 503, headers: { 'retry-after': '5' } });
    const refused = new Response('', { status: 404 });
    const lost = fetchFailed('ECONNREFUSED');
    const answers = [ok, busy, refused];
    const doFetch = (async () => {
      const next = answers.shift();
      if (!next) throw lost;
      return next;
    }) as typeof fetch;
    const reported = reportingFetch(reporter, 'gitea', doFetch);
    expect(await reported('http://gitea')).toBe(ok);
    expect(await reported('http://gitea')).toBe(busy);
    expect(await reported('http://gitea')).toBe(refused);
    await expect(reported('http://gitea')).rejects.toBe(lost);
    expect(reporter.answered.mock.calls).toEqual([['gitea'], ['gitea']]);
    expect(reporter.failed.mock.calls.map(([dependency, error]) => [dependency, failureOf(error)])).toEqual([
      ['gitea', { kind: 'temporary', reason: 'it answered 503, asking to be asked again after 5' }],
      ['gitea', { kind: 'temporary', reason: 'it refused the connection (ECONNREFUSED)' }],
    ]);
  });
});

const telemetry = { otlpEndpoint: undefined };
const noCluster = { here: { root: false } };

describe('dependenciesOf', () => {
  it('describes for an instance\'s backend every service the chart gives it, and root', () => {
    const backend = {
      koalaProcess: 'backend', telemetry, clusters: { here: { root: false, koalaMachineId: 'desk' } },
      tenant: { webTools: { searxngUrl: 'http://searxng:8080', crawl4aiUrl: 'http://crawl4ai:11235' } },
    } as unknown as BackendSettings;
    expect(dependenciesOf(backend)).toEqual(['mongo', 'temporal', 'collector', 'minio', 'gitea', 'infisical', 'registry', 'searxng', 'crawl4ai', 'quickwit', 'qdrant', 'tei', 'root']);
  });

  it('describes nothing a process has no setting for: no collector without a cluster or an endpoint, no web tools not given', () => {
    const backend = { koalaProcess: 'backend', telemetry, clusters: noCluster, tenant: { webTools: {} } } as unknown as BackendSettings;
    expect(dependenciesOf(backend)).toEqual(['mongo', 'temporal', 'minio', 'gitea', 'infisical', 'registry', 'quickwit', 'qdrant', 'tei', 'root']);
  });

  it('describes the memory index for every process that keeps or recalls memories, and for no process of root', () => {
    expect(dependenciesOf({ koalaProcess: 'backend', telemetry, clusters: noCluster, tenant: { webTools: {} } } as unknown as BackendSettings)).toEqual(['mongo', 'temporal', 'minio', 'gitea', 'infisical', 'registry', 'quickwit', 'qdrant', 'tei', 'root']);
    expect(dependenciesOf({ koalaProcess: 'backend', telemetry, clusters: noCluster } as unknown as BackendSettings)).toEqual(['mongo', 'temporal']);
    expect(DEPENDENCIES.quickwit).toEqual({ name: 'the memory index\'s words (Quickwit)', checkedBy: 'GET /health/readyz' });
    expect(DEPENDENCIES.qdrant).toEqual({ name: 'the memory index\'s meanings (Qdrant)', checkedBy: 'GET /readyz' });
    expect(DEPENDENCIES.tei).toEqual({ name: 'the memory index\'s embeddings (TEI)', checkedBy: 'GET /health' });
  });

  it('describes root\'s own and each worker\'s', () => {
    expect(dependenciesOf({ koalaProcess: 'backend', telemetry: { otlpEndpoint: 'http://127.0.0.1:4318' }, clusters: { here: { root: true } } } as unknown as BackendSettings)).toEqual(['mongo', 'temporal', 'collector']);
    expect(dependenciesOf({ koalaProcess: 'worker-engine', telemetry, clusters: noCluster, tenant: { webTools: { searxngUrl: 'http://searxng:8080' } } } as unknown as EngineWorkerSettings))
      .toEqual(['mongo', 'temporal', 'minio', 'gitea', 'infisical', 'registry', 'searxng', 'quickwit', 'qdrant', 'tei']);
    expect(dependenciesOf({ koalaProcess: 'worker-cluster', telemetry, clusters: noCluster } as unknown as ClusterWorkerSettings)).toEqual(['mongo', 'temporal', 'gitea', 'infisical']);
    expect(dependenciesOf({ koalaProcess: 'worker-host', telemetry, clusters: noCluster } as unknown as HostWorkerSettings)).toEqual(['mongo', 'temporal']);
  });
});

describe('downAcross', () => {
  it('puts this backend\'s own downs with what the workers recorded down, oldest first, leaving out what answers and the backend\'s own rows', () => {
    const own = [{ dependency: 'mongo' as const, name: 'the database', since: '2026-11-08T10:02:00.000Z', reason: 'it cannot be reached: closed', process: 'backend' as const }];
    expect(downAcross(own, [
      { process: 'worker-engine', dependency: 'gitea', state: 'down', since: '2026-11-08T10:01:00.000Z', reason: 'it answered 502', at: '2026-11-08T10:01:00.000Z' },
      { process: 'worker-cluster', dependency: 'gitea', state: 'answering', at: '2026-11-08T10:01:00.000Z' },
      { process: 'backend', dependency: 'minio', state: 'down', since: '2026-11-08T09:00:00.000Z', reason: 'stale', at: '2026-11-08T09:00:00.000Z' },
    ])).toEqual([
      { dependency: 'gitea', name: 'Gitea', since: '2026-11-08T10:01:00.000Z', reason: 'it answered 502', process: 'worker-engine' },
      own[0],
    ]);
  });

  it('carries a dependency a worker recorded as refused for good, saying it is refused', () => {
    expect(downAcross([], [
      { process: 'worker-engine', dependency: 'gitea', state: 'refused', since: '2026-11-08T10:01:00.000Z', reason: 'it refused the request (401)', at: '2026-11-08T10:01:00.000Z' },
    ])).toEqual([{ dependency: 'gitea', name: 'Gitea', since: '2026-11-08T10:01:00.000Z', reason: 'it refused the request (401)', process: 'worker-engine', refused: true }]);
  });
});
