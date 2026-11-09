import { causeCode, LOST_CONNECTION, streamCutOff } from '@koala/engine-core/failures';
import type { BackendSettings, ClusterWorkerSettings, EngineWorkerSettings, HostWorkerSettings, KoalaProcess, WebToolSettings } from './settings.js';
import { ownReach } from '../../infrastructure/lib/cluster-places.js';

export type DependencyId =
  | 'mongo' | 'temporal' | 'minio' | 'gitea' | 'infisical' | 'registry'
  | 'searxng' | 'crawl4ai' | 'root' | 'hub' | 'collector';

export interface DependencyDescription {
  name: string;
  checkedBy: string;
}

export const DEPENDENCIES: { readonly [D in DependencyId]: DependencyDescription } = {
  mongo: { name: 'the database', checkedBy: 'a ping on the connection this process holds, and the driver\'s own heartbeats' },
  temporal: { name: 'Temporal', checkedBy: 'asking its frontend for its system information' },
  minio: { name: 'file storage (MinIO)', checkedBy: 'GET /minio/health/live' },
  gitea: { name: 'Gitea', checkedBy: 'GET /api/healthz' },
  infisical: { name: 'Infisical', checkedBy: 'GET /api/status' },
  registry: { name: 'the image registry', checkedBy: 'GET /v2/, which answers whoever asks, signed in or not' },
  searxng: { name: 'web search (SearXNG)', checkedBy: 'GET /healthz' },
  crawl4ai: { name: 'page reading (Crawl4AI)', checkedBy: 'GET /health' },
  root: { name: 'Koala\'s root', checkedBy: 'whether this instance\'s connection to root is open' },
  hub: { name: 'the hub', checkedBy: 'whether this instance\'s connection to the hub is open' },
  collector: { name: 'the telemetry collector', checkedBy: 'whether its OTLP receiver answers' },
};

export const DEPENDENCY_IDS = Object.keys(DEPENDENCIES) as DependencyId[];

export const isDependencyId = (value: unknown): value is DependencyId =>
  typeof value === 'string' && (DEPENDENCY_IDS as string[]).includes(value);

export type Failure = { kind: 'temporary'; reason: string } | { kind: 'final'; reason: string };

export interface DependencyReporter {
  failed(dependency: DependencyId, error: unknown): unknown;
  answered(dependency: DependencyId): void;
}

const sinceAt = (since: string): string => `${new Date(since).toISOString().slice(11, 16)} UTC`;

export class DependencyDownError extends Error {
  readonly status = 503;

  constructor(
    readonly dependency: DependencyId,
    readonly since: string,
    readonly reason: string,
    options: { cause?: unknown } = {},
  ) {
    super(`${DEPENDENCIES[dependency].name.replace(/^./, (first) => first.toUpperCase())} isn't answering since ${sinceAt(since)}: ${reason}`, options);
    this.name = 'DependencyDownError';
  }
}

export const thrownFor = (reporter: DependencyReporter | undefined, dependency: DependencyId, error: unknown): unknown =>
  reporter?.failed(dependency, error) ?? error;

export type DependencyState =
  | { state: 'answering' }
  | { state: 'down'; since: string; reason: string };

export interface DependencyStateRow {
  process: KoalaProcess;
  dependency: DependencyId;
  state: 'answering' | 'down';
  since?: string | undefined;
  reason?: string | undefined;
  at: string;
}

export interface DependencyDown {
  dependency: DependencyId;
  name: string;
  since: string;
  reason: string;
  process: KoalaProcess;
  where?: string | undefined;
}

export const NAME_NOT_FOUND: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

export const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);

const CUT_OFF = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH']);
const TOO_SLOW = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ECONNABORTED']);
const TEMPORARY_CODES: ReadonlySet<string> = new Set([...LOST_CONNECTION, ...TOO_SLOW, 'EAI_AGAIN']);
const S3_TEMPORARY = new Set(['SlowDown', 'ServiceUnavailable', 'InternalError', 'RequestTimeout', 'XMinioServerNotInitialized']);
const MONGO_TEMPORARY = new Set(['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongoNotConnectedError', 'MongoTopologyClosedError']);
const GRPC_UNAVAILABLE = 14;
const GRPC_DEADLINE_EXCEEDED = 4;

const STILL_DOWN = 'DependencyStillDown';

export const stillDown = (reason: string): Error => Object.assign(new Error(reason), { name: STILL_DOWN });

const temporary = (reason: string): Failure => ({ kind: 'temporary', reason });
const final = (reason: string): Failure => ({ kind: 'final', reason });

const field = (value: unknown, name: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined;

const messageOf = (error: unknown): string => {
  const message = field(error, 'message');
  return typeof message === 'string' && message ? message : String(error);
};

const nameOf = (error: unknown): string | undefined => {
  const name = field(error, 'name');
  return typeof name === 'string' ? name : undefined;
};

export const refusedByServer = (error: unknown): boolean => nameOf(error) === 'ResponseBodyError';

const httpStatusOf = (error: unknown): number | undefined => {
  const candidates = [field(error, 'status'), field(field(error, 'response'), 'status'), field(error, 'statusCode')];
  return candidates.find((value): value is number => typeof value === 'number' && value >= 100 && value <= 599);
};

const retryAfterOf = (error: unknown): string | undefined => {
  const given = field(error, 'retryAfter') ?? field(field(field(error, 'response'), 'headers'), 'retry-after');
  return typeof given === 'string' && given.trim() ? given.trim() : undefined;
};

const codeOf = (error: unknown): string | undefined => {
  const own = field(error, 'code');
  return typeof own === 'string' && own ? own : causeCode(error);
};

const grpcCodeOf = (error: unknown): number | undefined => {
  const own = field(error, 'code');
  if (typeof own === 'number') return own;
  const cause = field(field(error, 'cause'), 'code');
  return typeof cause === 'number' ? cause : undefined;
};

export function statusFailure(status: number, retryAfter?: string): Failure {
  if (status === 429) return temporary(`it is busy and answered 429${retryAfter ? `, asking to be asked again after ${retryAfter}` : ''}`);
  if (status >= 500) return temporary(`it answered ${status}${retryAfter ? `, asking to be asked again after ${retryAfter}` : ''}`);
  if (GONE_STATUSES.has(status)) return final(`it says what was asked for is gone (${status})`);
  return final(`it refused the request (${status})`);
}

export const temporaryStatus = (status: number): boolean => status === 429 || status >= 500;

function codeFailure(code: string): Failure | undefined {
  if (code === 'ECONNREFUSED') return temporary(`it refused the connection (${code})`);
  if (CUT_OFF.has(code)) return temporary(`the connection to it was cut off (${code})`);
  if (UNREACHABLE.has(code)) return temporary(`its network cannot be reached (${code})`);
  if (TOO_SLOW.has(code)) return temporary(`it did not answer in time (${code})`);
  if (code === 'EAI_AGAIN') return temporary(`its name could not be looked up just now (${code})`);
  if (TEMPORARY_CODES.has(code)) return temporary(`the connection to it was lost (${code})`);
  if (NAME_NOT_FOUND.has(code)) return final(`its name does not resolve (${code})`);
  if (S3_TEMPORARY.has(code)) return temporary(`it answered ${code}`);
  return undefined;
}

export function failureOf(error: unknown): Failure {
  if (error instanceof DependencyDownError) return temporary(error.reason);
  if (nameOf(error) === STILL_DOWN) return temporary(messageOf(error));
  if (refusedByServer(error)) return final(`it refused: ${messageOf(error)}`);
  const status = httpStatusOf(error);
  if (status !== undefined) return statusFailure(status, retryAfterOf(error));
  const code = codeOf(error);
  const byCode = code ? codeFailure(code) : undefined;
  if (byCode) return byCode;
  const grpc = grpcCodeOf(error);
  if (grpc === GRPC_UNAVAILABLE) return temporary(`it is unavailable: ${messageOf(error)}`);
  if (grpc === GRPC_DEADLINE_EXCEEDED) return temporary(`it did not answer in time: ${messageOf(error)}`);
  const name = nameOf(error);
  if (name && MONGO_TEMPORARY.has(name)) return temporary(`it cannot be reached: ${messageOf(error)}`);
  if (name === 'TransportError') return temporary(`it cannot be reached: ${messageOf(error)}`);
  if (name === 'TimeoutError') return temporary('it did not answer in time');
  if (streamCutOff(error)) return temporary('the connection to it was cut off while it answered');
  return final(messageOf(error));
}

export const answerFailure = (status: number, retryAfter?: string | null): Error =>
  Object.assign(new Error(`it answered ${status}`), { status, ...(retryAfter ? { retryAfter } : {}) });

export function reportStatus(reporter: DependencyReporter, dependency: DependencyId, status: number, retryAfter?: string | null): void {
  if (temporaryStatus(status)) reporter.failed(dependency, answerFailure(status, retryAfter));
  else reporter.answered(dependency);
}

export function reportingFetch(reporter: DependencyReporter, dependency: DependencyId, doFetch: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let response: Response;
    try {
      response = await doFetch(input, init);
    } catch (err) {
      throw thrownFor(reporter, dependency, err);
    }
    reportStatus(reporter, dependency, response.status, response.headers.get('retry-after'));
    return response;
  }) as typeof fetch;
}

type AnyProcessSettings = BackendSettings | HostWorkerSettings | ClusterWorkerSettings | EngineWorkerSettings;

const sendsTelemetry = (settings: AnyProcessSettings): boolean =>
  Boolean(settings.telemetry.otlpEndpoint) || ownReach(settings.clusters.here) !== undefined;

const webDependencies = (web: WebToolSettings): DependencyId[] =>
  [...(web.searxngUrl ? ['searxng' as const] : []), ...(web.crawl4aiUrl ? ['crawl4ai' as const] : [])];

export function dependenciesOf(settings: AnyProcessSettings): DependencyId[] {
  const always: DependencyId[] = ['mongo', 'temporal', ...(sendsTelemetry(settings) ? ['collector' as const] : [])];
  switch (settings.koalaProcess) {
    case 'backend': {
      if (settings.tenant) return [...always, 'minio', 'gitea', 'infisical', 'registry', ...webDependencies(settings.tenant.webTools), 'root', 'hub'];
      if (settings.hubGitea) return [...always, 'gitea'];
      return always;
    }
    case 'worker-engine':
      return [...always, 'minio', 'gitea', 'infisical', 'registry', ...webDependencies(settings.tenant.webTools)];
    case 'worker-cluster':
      return [...always, 'gitea', 'infisical'];
    case 'worker-host':
      return always;
  }
}

export function downAcross(own: readonly DependencyDown[], rows: readonly DependencyStateRow[]): DependencyDown[] {
  const elsewhere = rows.flatMap((row): DependencyDown[] => {
    if (row.state !== 'down' || row.process === 'backend') return [];
    return [{ dependency: row.dependency, name: DEPENDENCIES[row.dependency].name, since: row.since ?? row.at, reason: row.reason ?? 'no reason was recorded', process: row.process }];
  });
  return [...own, ...elsewhere].sort((a, b) => a.since.localeCompare(b.since) || a.process.localeCompare(b.process));
}
