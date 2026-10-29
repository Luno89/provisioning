import type { Reach } from '../lib/instance-watch.js';
import { RootRefused } from './InstanceTrial.js';

export interface InstanceWatchView {
  notifyWhenUnreachable: boolean;
  alwaysTold: boolean;
  reach?: Reach | undefined;
}

export class InstanceWatchSetting {
  constructor(
    private readonly settings: { rootUrl: string; instanceId: string; credential: string },
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private async root(method: 'GET' | 'PUT', body?: unknown): Promise<InstanceWatchView> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/watch`, {
      method,
      headers: { 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${this.settings.credential}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const answer = await response.json().catch(() => ({})) as InstanceWatchView & { error?: unknown };
    if (!response.ok) throw new RootRefused(response.status, typeof answer.error === 'string' ? answer.error : `root answered ${response.status}`);
    return { notifyWhenUnreachable: answer.notifyWhenUnreachable, alwaysTold: answer.alwaysTold, ...(answer.reach ? { reach: answer.reach } : {}) };
  }

  read(): Promise<InstanceWatchView> {
    return this.root('GET');
  }

  set(notifyWhenUnreachable: boolean): Promise<InstanceWatchView> {
    return this.root('PUT', { notifyWhenUnreachable });
  }
}
