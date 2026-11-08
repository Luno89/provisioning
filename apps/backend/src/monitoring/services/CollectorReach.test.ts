import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess, ClusterProxyService } from '../../infrastructure/index.js';
import { COLLECTOR_RETRY_MS, collectorEndpoint, collectorSink } from './CollectorReach.js';

const KOALA = 'machine-dev1';

const reaching = (kubeconfig: string | Error) => {
  const access = mock<Pick<ClusterAccess, 'kubeconfigOf'>>();
  if (kubeconfig instanceof Error) access.kubeconfigOf.calledWith(KOALA).mockRejectedValue(kubeconfig);
  else access.kubeconfigOf.calledWith(KOALA).mockResolvedValue(kubeconfig);
  return access;
};

describe('reaching the collector on Koala\'s own cluster', () => {
  it('asks the cluster proxy for the collector\'s address with the kubeconfig ClusterAccess writes for Koala\'s cluster', async () => {
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    proxy.serviceUrl.calledWith(KOALA, 'otel-collector', '/run/koala/kubeconfig-koala').mockResolvedValue('http://10.43.0.7:4318/');
    const endpoint = collectorEndpoint({ env: {}, proxy, access: reaching('/run/koala/kubeconfig-koala'), koalasCluster: () => KOALA });
    expect(await endpoint()).toBe('http://10.43.0.7:4318/');
    expect(proxy.serviceUrl).toHaveBeenCalledTimes(1);
  });

  it('remembers why the collector could not be reached and does not ask again for a minute', async () => {
    let now = 1_000;
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    proxy.serviceUrl.mockRejectedValue(new Error('port-forward exited'));
    const endpoint = collectorEndpoint({ env: {}, proxy, access: reaching('/k'), koalasCluster: () => KOALA, now: () => now });
    await expect(endpoint()).rejects.toThrow(`the collector on ${KOALA} cannot be reached: port-forward exited`);
    await expect(endpoint()).rejects.toThrow('port-forward exited');
    expect(proxy.serviceUrl).toHaveBeenCalledTimes(1);
    now += COLLECTOR_RETRY_MS;
    await expect(endpoint()).rejects.toThrow('port-forward exited');
    expect(proxy.serviceUrl).toHaveBeenCalledTimes(2);
  });

  it('says why when Koala\'s cluster cannot be reached at all, without asking the proxy', async () => {
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    const endpoint = collectorEndpoint({ env: {}, proxy, access: reaching(new Error('this process is not running inside Koala\'s cluster')), koalasCluster: () => KOALA });
    await expect(endpoint()).rejects.toThrow(`the collector on ${KOALA} cannot be reached: this process is not running inside Koala's cluster`);
    expect(proxy.serviceUrl).not.toHaveBeenCalled();
  });

  it('asks again once the minute is up and answers when the collector is back', async () => {
    let now = 0;
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    proxy.serviceUrl.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce('http://10.43.0.7:4318/');
    const endpoint = collectorEndpoint({ env: {}, proxy, access: reaching('/k'), koalasCluster: () => KOALA, now: () => now });
    await expect(endpoint()).rejects.toThrow('down');
    now += COLLECTOR_RETRY_MS;
    expect(await endpoint()).toBe('http://10.43.0.7:4318/');
  });

  it('prefers the OTLP endpoint named in the environment over the cluster, as on root', async () => {
    const posted: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => { posted.push(String(url)); return new Response(null, { status: 200 }); }) as typeof fetch;
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    const access = mock<Pick<ClusterAccess, 'kubeconfigOf'>>();
    const sink = collectorSink({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }, proxy, access, koalasCluster: () => KOALA, fetchImpl });
    await sink.send('traces', new TextEncoder().encode('{}'));
    expect(posted).toEqual(['http://127.0.0.1:4318/v1/traces']);
    expect(access.kubeconfigOf).not.toHaveBeenCalled();
    expect(proxy.serviceUrl).not.toHaveBeenCalled();
  });

  it('sends to the collector on Koala\'s cluster when the environment names none, and fails a send with the reason when it cannot be reached', async () => {
    const posted: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => { posted.push(String(url)); return new Response(null, { status: 200 }); }) as typeof fetch;
    const proxy = mock<Pick<ClusterProxyService, 'serviceUrl'>>();
    proxy.serviceUrl.calledWith(KOALA, 'otel-collector', '/k').mockResolvedValue('http://10.43.0.7:4318/');
    await collectorSink({ env: {}, proxy, access: reaching('/k'), koalasCluster: () => KOALA, fetchImpl }).send('metrics', new TextEncoder().encode('{}'));
    expect(posted).toEqual(['http://10.43.0.7:4318/v1/metrics']);
    const unreachable = collectorSink({ env: {}, proxy, access: reaching(new Error('there is no cluster provisioning-lunorica')), koalasCluster: () => KOALA, fetchImpl });
    await expect(unreachable.send('metrics', new TextEncoder().encode('{}'))).rejects.toThrow('there is no cluster provisioning-lunorica');
  });
});

describe('a process that runs in no cluster of its own', () => {
  it('starts, and only a send says why there is no collector to reach', async () => {
    const access = mock<Parameters<typeof collectorEndpoint>[0]['access']>();
    const proxy = mock<Parameters<typeof collectorEndpoint>[0]['proxy']>();
    const endpoint = collectorEndpoint({ env: {}, access, proxy, koalasCluster: () => { throw new Error('this process runs in no cluster of its own'); } });
    await expect(endpoint()).rejects.toThrow('the collector on Koala\'s own cluster cannot be reached: this process runs in no cluster of its own');
    expect(proxy.serviceUrl).not.toHaveBeenCalled();
  });
});
