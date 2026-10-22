import type { MonitoringAsk, RangeAsk } from '../lib/monitoring-asks.js';
import type { PromAlert } from '../lib/monitoring-alerts.js';
import type { PoolProbe, PoolRule } from '../lib/pool-monitoring.js';
import type { PoolMonitor, Sample } from './MonitoringService.js';

export interface PoolMonitorSettings {
  rootUrl: string;
  instanceId: string;
  credential: string;
}

export function poolMonitorFrom(env: NodeJS.ProcessEnv): PoolMonitorSettings | undefined {
  if (env.POOL !== 'true') return undefined;
  const rootUrl = env.ROOT_URL?.trim();
  const instanceId = env.INSTANCE_ID?.trim();
  const credential = env.INSTANCE_CREDENTIAL?.trim();
  return rootUrl && instanceId && credential ? { rootUrl: rootUrl.replace(/\/$/, ''), instanceId, credential } : undefined;
}

export function poolMonitor(settings: PoolMonitorSettings, fetchImpl: typeof fetch = globalThis.fetch): PoolMonitor {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetchImpl(`${settings.rootUrl}/api/instances/monitoring${path}`, {
      method,
      headers: {
        'x-instance-id': settings.instanceId,
        authorization: `Bearer ${settings.credential}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = await response.json().catch(() => ({})) as T & { error?: unknown };
    if (!response.ok) throw new Error(`root answered ${response.status}: ${typeof answer.error === 'string' ? answer.error : 'no reason given'}`);
    return answer;
  };
  return {
    ask: async (ask: MonitoringAsk) => (await call<{ samples: Sample[] }>('POST', '/ask', { ask })).samples,
    askRange: async (ask: MonitoringAsk, range: RangeAsk) => (await call<{ points: Array<[number, number]> }>('POST', '/ask', { ask, range })).points,
    alerts: async () => (await call<{ alerts: PromAlert[] }>('GET', '/alerts')).alerts,
    history: () => call<{ days: number; kept?: number }>('GET', ''),
    setRule: async (rule: PoolRule) => {
      await call('PUT', `/rules/${encodeURIComponent(rule.id)}`, { namespace: rule.namespace, spec: rule.spec, summary: rule.summary });
    },
    removeRule: async (id: string) => {
      await call('DELETE', `/rules/${encodeURIComponent(id)}`);
    },
    setProbes: async (probes: PoolProbe[]) => {
      await call('PUT', '/probes', { probes });
    },
  };
}
