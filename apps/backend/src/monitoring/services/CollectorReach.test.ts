import { describe, expect, it } from 'vitest';
import { COLLECTOR_RETRY_MS, collectorEndpoint, collectorSink } from './CollectorReach.js';

describe('reaching the collector on the system cluster', () => {
  it('asks the cluster proxy for the collector\'s address the way Prometheus is reached, once it has a kubeconfig', async () => {
    const asked: string[] = [];
    const endpoint = collectorEndpoint({
      env: {},
      proxy: { serviceUrl: async (clusterId, service) => { asked.push(`${clusterId}/${service}`); return 'http://10.43.0.7:4318/'; } },
      kubeconfigPath: () => '/tmp/kubeconfig-provisioning-lunorica',
    });
    expect(await endpoint()).toBe('http://10.43.0.7:4318/');
    expect(asked).toEqual(['system/otel-collector']);
  });

  it('remembers that the collector could not be reached and does not ask again for a minute', async () => {
    let now = 1_000;
    let asks = 0;
    const endpoint = collectorEndpoint({
      env: {},
      proxy: { serviceUrl: async () => { asks += 1; throw new Error('port-forward exited'); } },
      kubeconfigPath: () => '/k',
      now: () => now,
    });
    expect(await endpoint()).toBeUndefined();
    expect(await endpoint()).toBeUndefined();
    expect(asks).toBe(1);
    now += COLLECTOR_RETRY_MS;
    expect(await endpoint()).toBeUndefined();
    expect(asks).toBe(2);
  });

  it('answers nothing while the system cluster has no kubeconfig', async () => {
    let asks = 0;
    const endpoint = collectorEndpoint({ env: {}, proxy: { serviceUrl: async () => { asks += 1; return 'x'; } }, kubeconfigPath: async () => undefined });
    expect(await endpoint()).toBeUndefined();
    expect(asks).toBe(0);
  });

  it('prefers the OTLP endpoint named in the environment over the cluster, as on root', async () => {
    const posted: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => { posted.push(String(url)); return new Response(null, { status: 200 }); }) as typeof fetch;
    const sink = collectorSink({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }, proxy: { serviceUrl: async () => { throw new Error('never asked'); } }, kubeconfigPath: () => '/k', fetchImpl });
    await sink.send('traces', new TextEncoder().encode('{}'));
    expect(posted).toEqual(['http://127.0.0.1:4318/v1/traces']);
  });
});
