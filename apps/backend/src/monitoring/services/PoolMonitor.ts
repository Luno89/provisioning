import type { MonitoringAsk, RangeAsk } from '../lib/monitoring-asks.js';
import type { PoolProbe, PoolRule } from '../lib/pool-monitoring.js';
import type { PoolMonitor } from './MonitoringService.js';
import { answeredHistory, answeredPoints, answeredSamples, promAlerts } from '../lib/prometheus-answers.js';
import { textAt } from '../../platform/index.js';

export interface PoolMonitorSettings {
  rootUrl: string;
  instanceId: string;
  token: () => Promise<string>;
}

export function poolMonitorFrom(env: NodeJS.ProcessEnv, token: (() => Promise<string>) | undefined): PoolMonitorSettings | undefined {
  if (env.POOL !== 'true') return undefined;
  const rootUrl = env.ROOT_URL?.trim();
  const instanceId = env.INSTANCE_ID?.trim();
  return rootUrl && instanceId && token ? { rootUrl: rootUrl.replace(/\/$/, ''), instanceId, token } : undefined;
}

export function poolMonitor(settings: PoolMonitorSettings, fetchImpl: typeof fetch = globalThis.fetch): PoolMonitor {
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${settings.rootUrl}/api/instances/monitoring${path}`, {
      method,
      headers: {
        'x-instance-id': settings.instanceId,
        authorization: `Bearer ${await settings.token()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let answer: unknown = {};
    try {
      if (text) answer = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) throw new Error(`root answered ${response.status} with something that is not JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok) throw new Error(`root answered ${response.status}: ${textAt(answer, 'error') ?? 'no reason given'}`);
    return answer;
  };
  return {
    ask: async (ask: MonitoringAsk) => answeredSamples(await call('POST', '/ask', { ask })),
    askRange: async (ask: MonitoringAsk, range: RangeAsk) => answeredPoints(await call('POST', '/ask', { ask, range })),
    alerts: async () => promAlerts(await call('GET', '/alerts')),
    history: async () => answeredHistory(await call('GET', '')),
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
