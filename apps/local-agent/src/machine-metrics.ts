import { METRICS_CLIENT_SECRET, type MetricsClient } from '@koala/engine-core/root-client';

export const metricsClientManifest = (client: MetricsClient): string => `${JSON.stringify({
  apiVersion: 'v1',
  kind: 'List',
  items: [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: METRICS_CLIENT_SECRET.namespace } },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: METRICS_CLIENT_SECRET.name, namespace: METRICS_CLIENT_SECRET.namespace },
      type: 'Opaque',
      stringData: { [METRICS_CLIENT_SECRET.idKey]: client.clientId, [METRICS_CLIENT_SECRET.secretKey]: client.clientSecret },
    },
  ],
}, null, 2)}\n`;
