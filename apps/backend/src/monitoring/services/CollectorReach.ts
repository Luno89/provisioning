import { envSink, OTLP_ENDPOINT_VAR, otlpHttpSink, type TelemetrySink } from '@koala/engine-core/telemetry-sdk';
import type { ClusterProxyService } from '../../infrastructure/index.js';
import { TELEMETRY_SERVICES } from '../lib/cluster-monitoring.js';

export const COLLECTOR_RETRY_MS = 60_000;

export interface CollectorReachDeps {
  otlpEndpoint: string | undefined;
  proxy: Pick<ClusterProxyService, 'serviceUrl'>;
  koalasCluster: () => string;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

export function collectorEndpoint(deps: Omit<CollectorReachDeps, 'otlpEndpoint'>): () => Promise<string> {
  const now = deps.now ?? (() => Date.now());
  let failed: { at: number; why: Error } | undefined;
  return async () => {
    if (failed !== undefined && now() - failed.at < COLLECTOR_RETRY_MS) throw failed.why;
    let where = 'Koala\'s own cluster';
    try {
      const cluster = deps.koalasCluster();
      where = cluster;
      const url = await deps.proxy.serviceUrl(cluster, TELEMETRY_SERVICES.collector);
      failed = undefined;
      return url;
    } catch (err) {
      failed = { at: now(), why: new Error(`the collector on ${where} cannot be reached: ${(err as Error).message}`) };
      throw failed.why;
    }
  };
}

export function collectorSink(deps: CollectorReachDeps): TelemetrySink {
  return envSink({ [OTLP_ENDPOINT_VAR]: deps.otlpEndpoint }, deps.fetchImpl) ?? otlpHttpSink(collectorEndpoint(deps), deps.fetchImpl);
}
