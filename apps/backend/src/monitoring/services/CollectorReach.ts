import { envSink, otlpHttpSink, type TelemetrySink } from '@koala/engine-core/telemetry-sdk';
import type { ClusterProxyService } from '../../infrastructure/index.js';
import { TELEMETRY_SERVICES } from '../lib/cluster-monitoring.js';

export const COLLECTOR_RETRY_MS = 60_000;

export interface CollectorReachDeps {
  env: Readonly<Record<string, string | undefined>>;
  proxy: Pick<ClusterProxyService, 'serviceUrl'>;
  kubeconfigPath: () => Promise<string | undefined> | string | undefined;
  clusterId?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

export function collectorEndpoint(deps: CollectorReachDeps): () => Promise<string | undefined> {
  const now = deps.now ?? (() => Date.now());
  let failedAt: number | undefined;
  return async () => {
    if (failedAt !== undefined && now() - failedAt < COLLECTOR_RETRY_MS) return undefined;
    try {
      const kubeconfig = await deps.kubeconfigPath();
      if (!kubeconfig) throw new Error('the system cluster has no kubeconfig yet');
      const url = await deps.proxy.serviceUrl(deps.clusterId ?? 'system', TELEMETRY_SERVICES.collector, kubeconfig);
      failedAt = undefined;
      return url;
    } catch {
      failedAt = now();
      return undefined;
    }
  };
}

export function collectorSink(deps: CollectorReachDeps): TelemetrySink {
  return envSink(deps.env, deps.fetchImpl) ?? otlpHttpSink(collectorEndpoint(deps), deps.fetchImpl);
}
