import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterProxyService } from '../../infrastructure/index.js';
import { COLLECTOR_RETRY_MS, collectorEndpoint, collectorSink } from './CollectorReach.js';

const KOALA = 'machine-dev1';

describe('reaching the collector on Koala\'s own cluster', () => {
  it('asks the cluster proxy for the collector\'s address on Koala\'s cluster, by its id', async () => {
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    proxy.serviceUrl.calledWith(KOALA, 'otel-collector').mockResolvedValue('http://10.43.0.7:4318/');
    const endpoint = collectorEndpoint({ env: {}, proxy, koalasCluster: () => KOALA });
    expect(await endpoint()).toBe('http://10.43.0.7:4318/');
    expect(proxy.serviceUrl).toHaveBeenCalledTimes(1);
  });

  it('remembers why the collector could not be reached and does not ask again for a minute', async () => {
    let now = 1_000;
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    proxy.serviceUrl.mockRejectedValue(new Error('port-forward exited'));
    const endpoint = collectorEndpoint({ env: {}, proxy, koalasCluster: () => KOALA, now: () => now });
    await expect(endpoint()).rejects.toThrow(`the collector on ${KOALA} cannot be reached: port-forward exited`);
    await expect(endpoint()).rejects.toThrow('port-forward exited');
    expect(proxy.serviceUrl).toHaveBeenCalledTimes(1);
    now += COLLECTOR_RETRY_MS;
    await expect(endpoint()).rejects.toThrow('port-forward exited');
    expect(proxy.serviceUrl).toHaveBeenCalledTimes(2);
  });

  it('says why when Koala\'s cluster cannot be reached at all', async () => {
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    proxy.serviceUrl.mockRejectedValue(new Error('this process is not running inside Koala\'s cluster'));
    const endpoint = collectorEndpoint({ env: {}, proxy, koalasCluster: () => KOALA });
    await expect(endpoint()).rejects.toThrow(`the collector on ${KOALA} cannot be reached: this process is not running inside Koala's cluster`);
  });

  it('asks again once the minute is up and answers when the collector is back', async () => {
    let now = 0;
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    proxy.serviceUrl.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce('http://10.43.0.7:4318/');
    const endpoint = collectorEndpoint({ env: {}, proxy, koalasCluster: () => KOALA, now: () => now });
    await expect(endpoint()).rejects.toThrow('down');
    now += COLLECTOR_RETRY_MS;
    expect(await endpoint()).toBe('http://10.43.0.7:4318/');
  });

  it('prefers the OTLP endpoint named in the environment over the cluster, as on root', async () => {
    const posted: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => { posted.push(String(url)); return new Response(null, { status: 200 }); }) as typeof fetch;
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    const sink = collectorSink({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }, proxy, koalasCluster: () => KOALA, fetchImpl });
    await sink.send('traces', new TextEncoder().encode('{}'));
    expect(posted).toEqual(['http://127.0.0.1:4318/v1/traces']);
    expect(proxy.serviceUrl).not.toHaveBeenCalled();
  });

  it('sends to the collector on Koala\'s cluster when the environment names none, and fails a send with the reason when it cannot be reached', async () => {
    const posted: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => { posted.push(String(url)); return new Response(null, { status: 200 }); }) as typeof fetch;
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    proxy.serviceUrl.calledWith(KOALA, 'otel-collector').mockResolvedValue('http://10.43.0.7:4318/');
    await collectorSink({ env: {}, proxy, koalasCluster: () => KOALA, fetchImpl }).send('metrics', new TextEncoder().encode('{}'));
    expect(posted).toEqual(['http://10.43.0.7:4318/v1/metrics']);
    const refusing = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    refusing.serviceUrl.mockRejectedValue(new Error('there is no cluster machine-gone'));
    const unreachable = collectorSink({ env: {}, proxy: refusing, koalasCluster: () => KOALA, fetchImpl });
    await expect(unreachable.send('metrics', new TextEncoder().encode('{}'))).rejects.toThrow('there is no cluster machine-gone');
  });
});

describe('a process that runs in no cluster of its own', () => {
  it('starts, and only a send says why there is no collector to reach', async () => {
    const proxy = mock<Parameters<typeof collectorEndpoint>[0]['proxy']>();
    const endpoint = collectorEndpoint({ env: {}, proxy, koalasCluster: () => { throw new Error('this process runs in no cluster of its own'); } });
    await expect(endpoint()).rejects.toThrow('the collector on Koala\'s own cluster cannot be reached: this process runs in no cluster of its own');
    expect(proxy.serviceUrl).not.toHaveBeenCalled();
  });
});
