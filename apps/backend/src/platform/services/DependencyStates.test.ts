import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { DependencyStates } from './DependencyStates.js';
import { REOPEN_FIRST_MS } from '@koala/engine-core/reopening';
import { DependencyDownError, type DependencyStateRow } from '../lib/dependencies.js';

const refused = (): Error => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const NOW = new Date('2026-11-08T10:00:00.000Z');

const quiet = () => undefined;

function states(over: { record?: (row: DependencyStateRow) => Promise<void> } = {}) {
  const rows: DependencyStateRow[] = [];
  const record = over.record ?? (async (row: DependencyStateRow) => { rows.push(row); });
  const made = new DependencyStates({ process: 'worker-engine', described: ['mongo', 'gitea', 'minio'], record, now: () => new Date(Date.now()), log: quiet });
  return { made, rows };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DependencyStates', () => {
  it('marks a dependency down on a temporary failure, with when and why, and never on a final one', async () => {
    const { made } = states();
    made.checkWith('gitea', async () => { throw refused(); });
    made.failed('gitea', Object.assign(new Error('nope'), { response: { status: 403 } }));
    expect(made.stateOf('gitea')).toEqual({ state: 'answering' });
    made.failed('gitea', refused());
    expect(made.stateOf('gitea')).toEqual({ state: 'down', since: NOW.toISOString(), reason: 'it refused the connection (ECONNREFUSED)' });
    vi.setSystemTime(new Date(NOW.getTime() + 1_000));
    made.failed('gitea', Object.assign(new Error('busy'), { status: 503 }));
    expect(made.stateOf('gitea')).toEqual({ state: 'down', since: NOW.toISOString(), reason: 'it refused the connection (ECONNREFUSED)' });
    expect(made.down()).toEqual([{ dependency: 'gitea', name: 'Gitea', since: NOW.toISOString(), reason: 'it refused the connection (ECONNREFUSED)', process: 'worker-engine' }]);
    made.stop();
  });

  it('shows a dependency whose check is refused at start, and clears it once the check answers', async () => {
    const { made, rows } = states();
    let answers = false;
    made.checkWith('mongo', async () => undefined);
    made.checkWith('minio', async () => undefined);
    made.checkWith('gitea', async () => { if (!answers) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
    await made.start();
    expect(made.stateOf('gitea')).toEqual({ state: 'down', since: NOW.toISOString(), reason: 'its check at start was refused: its name does not resolve (ENOTFOUND)' });
    expect(rows.find((row) => row.dependency === 'gitea')).toMatchObject({ state: 'down', reason: 'its check at start was refused: its name does not resolve (ENOTFOUND)' });
    answers = true;
    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS);
    expect(made.stateOf('gitea')).toEqual({ state: 'answering' });
    made.stop();
  });

  it('checks again only while down, 5 s doubling to a minute, and is answering again on the first check that answers', async () => {
    const { made } = states();
    let answers = false;
    const check = vi.fn(async () => { if (!answers) throw refused(); });
    made.checkWith('minio', check);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(check).not.toHaveBeenCalled();

    const wentDown = Date.now();
    made.failed('minio', refused());
    const at: number[] = [];
    check.mockImplementation(async () => { at.push(Date.now() - wentDown); if (!answers) throw refused(); });
    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS + 10_000 + 20_000 + 40_000 + 60_000 + 60_000);
    expect(at).toEqual([5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);

    answers = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(made.stateOf('minio')).toEqual({ state: 'answering' });
    const calls = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(check.mock.calls.length).toBe(calls);
    made.stop();
  });

  it('is answering again when a caller says so, stops checking and starts the next outage at 5 s again', async () => {
    const { made } = states();
    const check = vi.fn(async () => { throw refused(); });
    made.checkWith('gitea', check);
    made.failed('gitea', refused());
    await vi.advanceTimersByTimeAsync(5_000 + 10_000);
    expect(check).toHaveBeenCalledTimes(2);
    made.answered('gitea');
    expect(made.stateOf('gitea')).toEqual({ state: 'answering' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(check).toHaveBeenCalledTimes(2);
    made.failed('gitea', refused());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(check).toHaveBeenCalledTimes(3);
    made.stop();
  });

  it('checks each dependency once at start, and refuses to start when one has no check', async () => {
    const { made, rows } = states();
    const mongo = vi.fn(async () => undefined);
    const gitea = vi.fn(async () => { throw refused(); });
    made.checkWith('mongo', mongo);
    made.checkWith('gitea', gitea);
    expect(() => made.start()).toThrow('worker-engine uses minio and was given no way to check it');
    made.checkWith('minio', async () => { throw Object.assign(new Error('denied'), { name: 'S3Error', code: 'AccessDenied' }); });
    await made.start();
    expect(mongo).toHaveBeenCalledTimes(1);
    expect(gitea).toHaveBeenCalledTimes(1);
    expect(made.stateOf('gitea').state).toBe('down');
    expect(made.stateOf('minio')).toEqual({ state: 'down', since: NOW.toISOString(), reason: 'its check at start was refused: denied' });
    expect(rows.map((row) => [row.dependency, row.state])).toEqual([['gitea', 'down'], ['minio', 'down']]);
    made.stop();
  });

  it('follows a dependency its open connection reports on, checking it neither at start nor again on a timer, down and back only as the connection says', async () => {
    const rows: DependencyStateRow[] = [];
    const made = new DependencyStates({ process: 'backend', described: ['mongo', 'root'], record: async (row) => { rows.push(row); }, now: () => new Date(Date.now()), log: quiet });
    made.checkWith('mongo', async () => undefined);
    made.toldByConnection('root');
    await made.start();
    expect(made.stateOf('root').state).toBe('answering');
    made.wentDown('root', 'this instance\'s connection to it is closed', NOW.toISOString());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(made.stateOf('root')).toEqual({ state: 'down', since: NOW.toISOString(), reason: 'this instance\'s connection to it is closed' });
    made.answered('root');
    expect(made.stateOf('root').state).toBe('answering');
    expect(rows.filter((row) => row.dependency === 'root').map((row) => row.state)).toEqual(['answering', 'down', 'answering']);
    made.stop();
  });

  it('records a change of state only, never the database\'s own, and records what it could not once the database answers', async () => {
    let failing = true;
    const rows: DependencyStateRow[] = [];
    const { made } = states({ record: async (row) => { if (failing) throw new Error('the database is away'); rows.push(row); } });
    made.checkWith('gitea', async () => { throw refused(); });
    made.checkWith('mongo', async () => { throw refused(); });
    made.failed('mongo', Object.assign(new Error('closed'), { name: 'MongoNetworkError' }));
    made.failed('gitea', refused());
    made.failed('gitea', refused());
    await vi.advanceTimersByTimeAsync(0);
    expect(rows).toEqual([]);
    failing = false;
    made.answered('mongo');
    await vi.advanceTimersByTimeAsync(0);
    expect(rows).toEqual([{ process: 'worker-engine', dependency: 'gitea', state: 'down', since: NOW.toISOString(), reason: 'it refused the connection (ECONNREFUSED)', at: NOW.toISOString() }]);
    made.answered('gitea');
    made.answered('gitea');
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.map((row) => row.state)).toEqual(['down', 'answering']);
    made.stop();
  });

  it('hands a caller back what to throw: the dependency\'s state for a temporary failure, the error itself for a final one', () => {
    const { made } = states();
    const cause = refused();
    const thrown = made.failed('gitea', cause);
    expect(thrown).toBeInstanceOf(DependencyDownError);
    expect(thrown).toMatchObject({
      message: 'Gitea isn\'t answering since 10:00 UTC: it refused the connection (ECONNREFUSED)',
      status: 503,
      dependency: 'gitea',
      since: NOW.toISOString(),
      reason: 'it refused the connection (ECONNREFUSED)',
      cause,
    });
    vi.setSystemTime(new Date(NOW.getTime() + 120_000));
    expect((made.failed('gitea', Object.assign(new Error('busy'), { status: 503 })) as Error).message).toBe('Gitea isn\'t answering since 10:00 UTC: it refused the connection (ECONNREFUSED)');
    const forbidden = Object.assign(new Error('nope'), { response: { status: 403 } });
    expect(made.failed('gitea', forbidden)).toBe(forbidden);
    expect(made.failed('minio', thrown)).toMatchObject({ dependency: 'minio', reason: 'it refused the connection (ECONNREFUSED)' });
    made.stop();
  });

  it('takes a dependency a reporter judged down with the time the reporter gives', () => {
    const { made } = states();
    made.wentDown('gitea', 'it closed the connection', '2026-11-08T09:50:00.000Z');
    expect(made.stateOf('gitea')).toEqual({ state: 'down', since: '2026-11-08T09:50:00.000Z', reason: 'it closed the connection' });
    made.stop();
  });

  it('ignores, and says once, a report about a dependency this process is not described as using', () => {
    const said: string[] = [];
    const made = new DependencyStates({ process: 'worker-cluster', described: ['gitea'], log: (line) => said.push(line) });
    made.failed('minio', refused());
    made.failed('minio', refused());
    expect(made.down()).toEqual([]);
    expect(said).toEqual(['[dependencies] worker-cluster: was told about file storage (MinIO), which it is not described as using; check its wiring']);
    made.stop();
  });

  it('names where a dependency is reached when it was told, as it is for root', () => {
    const made = new DependencyStates({ process: 'backend', described: ['root'], where: { root: 'https://app.koala.dev' }, log: quiet, now: () => NOW });
    made.wentDown('root', 'this instance\'s connection to it is closed', '2026-11-08T09:50:00.000Z');
    expect(made.down()).toEqual([{ dependency: 'root', name: 'Koala\'s root', since: '2026-11-08T09:50:00.000Z', reason: 'this instance\'s connection to it is closed', process: 'backend', where: 'https://app.koala.dev' }]);
    made.stop();
  });
});

describe('koala_dependency_up', () => {
  it('is one for each dependency this process uses while it answers and zero while it is down, by dependency', async () => {
    vi.useRealTimers();
    const sent: unknown[] = [];
    const telemetry = startTelemetry({ service: 'koala-test', sink: { async send(signal, body) { if (signal === 'metrics') sent.push(JSON.parse(Buffer.from(body).toString('utf8'))); } }, spanDelayMs: 10, metricsEveryMs: 60_000, log: quiet });
    const made = new DependencyStates({ process: 'backend', described: ['gitea', 'minio'], log: quiet });
    try {
      made.failed('minio', refused());
      await telemetry.flush();
      const points = (sent as { resourceMetrics: { scopeMetrics: { metrics: { name: string; gauge?: { dataPoints: { asInt?: number; asDouble?: number; attributes: { key: string; value: { stringValue: string } }[] }[] } }[] }[] }[] }[])
        .flatMap((batch) => batch.resourceMetrics).flatMap((resource) => resource.scopeMetrics).flatMap((scope) => scope.metrics)
        .filter((metric) => metric.name === 'koala_dependency_up')
        .flatMap((metric) => metric.gauge?.dataPoints ?? [])
        .map((point) => [point.attributes.find((attribute) => attribute.key === 'dependency')?.value.stringValue, point.asDouble ?? point.asInt]);
      expect(points).toEqual([['gitea', 1], ['minio', 0]]);
    } finally {
      made.stop();
      await telemetry.shutdown();
    }
  });
});
