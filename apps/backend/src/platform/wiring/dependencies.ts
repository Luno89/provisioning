import axios from 'axios';
import { useDependencyHttp } from '@koala/engine-core/http';
import type { SinkListener } from '@koala/engine-core/telemetry-sdk';
import { answerFailure, dependenciesOf, minioHealthUrl, temporaryStatus, type DependencyId, type DependencyReporter } from '../lib/dependencies.js';
import type { MongoTarget } from '../lib/mongo-target.js';
import type { Db } from 'mongodb';
import { leaseMongo, type MongoLease } from '../lib/mongo-lease.js';
import { isOff, type BackendSettings, type ClusterWorkerSettings, type EngineWorkerSettings, type HostWorkerSettings, type MemoryIndex, type Off, type WebToolSettings } from '../lib/settings.js';
import { getTemporalClient, reportTemporalTo } from '../lib/temporal-client.js';
import { MongoPlatformStore } from '../store.js';
import { DependencyStates, type DependencyCheck, type DependencyStatesDeps } from '../services/DependencyStates.js';

export type ProcessSettings = BackendSettings | HostWorkerSettings | ClusterWorkerSettings | EngineWorkerSettings;

export function answersHttp(url: string, doFetch: typeof fetch = fetch): DependencyCheck {
  return async () => {
    const response = await doFetch(url);
    await response.body?.cancel();
    if (temporaryStatus(response.status)) throw answerFailure(response.status, response.headers.get('retry-after'));
  };
}

const trimmed = (url: string): string => url.replace(/\/+$/, '');

export const temporalAnswers: DependencyCheck = async () => {
  await (await getTemporalClient()).workflowService.getSystemInfo({});
};

export function collectorAnswers(endpoint: () => Promise<string | undefined> | string | undefined, doFetch: typeof fetch = fetch): DependencyCheck {
  return async () => {
    const base = await endpoint();
    if (!base) throw Object.assign(new Error('no collector is reachable yet'), { code: 'ECONNREFUSED' });
    await answersHttp(`${trimmed(base)}/v1/metrics`, doFetch)();
  };
}

export function reportCollectorTo(telemetry: { reportSinkTo(listener: SinkListener): void }, states: DependencyStates): void {
  if (states.uses('collector')) telemetry.reportSinkTo(sinkListenerFor(states));
}

export const sinkListenerFor = (reporter: DependencyReporter): SinkListener => ({
  failed: (err) => reporter.failed('collector', err),
  answered: () => reporter.answered('collector'),
});

export interface ServiceAddresses {
  gitea?: string | undefined;
  infisical?: string | undefined;
  minio?: { endPoint: string; port: number; useSSL: boolean } | undefined;
  registryPush?: string | undefined;
  webTools?: WebToolSettings | undefined;
  memoryIndex?: MemoryIndex | Off | undefined;
}

const indexChecks = (index: MemoryIndex | Off | undefined): [DependencyId, string | undefined][] =>
  index && !isOff(index)
    ? [['quickwit', `${trimmed(index.index.base)}/health/readyz`], ['qdrant', `${trimmed(index.vectors.base)}/readyz`], ['tei', `${trimmed(index.embeddings.base)}/health`]]
    : [];

export function checkServices(states: DependencyStates, at: ServiceAddresses, doFetch: typeof fetch = fetch): void {
  const checks: [DependencyId, string | undefined][] = [
    ['gitea', at.gitea && `${trimmed(at.gitea)}/api/healthz`],
    ['infisical', at.infisical && `${trimmed(at.infisical)}/api/status`],
    ['minio', at.minio && minioHealthUrl(at.minio)],
    ['registry', at.registryPush && `http://${at.registryPush}/v2/`],
    ['searxng', at.webTools?.searxngUrl && `${trimmed(at.webTools.searxngUrl)}/healthz`],
    ['crawl4ai', at.webTools?.crawl4aiUrl && `${trimmed(at.webTools.crawl4aiUrl)}/health`],
    ...indexChecks(at.memoryIndex),
  ];
  for (const [dependency, url] of checks) if (url) states.checkWith(dependency, answersHttp(url, doFetch));
}

export function useOneHttpClient(): void {
  const { httpAgent, httpsAgent } = useDependencyHttp();
  axios.defaults.httpAgent = httpAgent;
  axios.defaults.httpsAgent = httpsAgent;
}

export function dependencyStatesFor(settings: ProcessSettings, options: { record?: DependencyStatesDeps['record']; where?: Partial<Record<DependencyId, string>> } = {}): DependencyStates {
  useOneHttpClient();
  const states = new DependencyStates({ process: settings.koalaProcess, described: dependenciesOf(settings), ...options });
  reportTemporalTo(states);
  states.checkWith('temporal', temporalAnswers);
  return states;
}

export async function workerDependencies(settings: Exclude<ProcessSettings, BackendSettings>, mongo: MongoTarget): Promise<DependencyStates> {
  let lease: MongoLease | undefined;
  const db = (): Db => {
    if (!lease) throw new Error('this worker has not reached its Mongo yet');
    return lease.client.db(mongo.dbName);
  };
  const store = new MongoPlatformStore(db);
  const states = dependencyStatesFor(settings, { record: (row) => store.saveDependencyState(row) });
  lease = await leaseMongo(mongo.uri, [states]);
  states.checkWith('mongo', async () => { await db().command({ ping: 1 }); });
  return states;
}
