import { temporaryStatus } from '@koala/engine-core/failures';
export { failureOf, GONE_STATUSES, NAME_NOT_FOUND, refusedByServer, statusFailure, stillDown, temporaryStatus, type Failure } from '@koala/engine-core/failures';
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
      return [...always, ...webDependencies(settings.webTools)];
  }
}

export function downAcross(own: readonly DependencyDown[], rows: readonly DependencyStateRow[]): DependencyDown[] {
  const elsewhere = rows.flatMap((row): DependencyDown[] => {
    if (row.state !== 'down' || row.process === 'backend') return [];
    return [{ dependency: row.dependency, name: DEPENDENCIES[row.dependency].name, since: row.since ?? row.at, reason: row.reason ?? 'no reason was recorded', process: row.process }];
  });
  return [...own, ...elsewhere].sort((a, b) => a.since.localeCompare(b.since) || a.process.localeCompare(b.process));
}
