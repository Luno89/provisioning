import type { Reach } from '../lib/instance-watch.js';
import { rootAnswer } from '../lib/root-answer.js';
import { RootRefused } from './InstanceTrial.js';

export interface InstanceWatchView {
  notifyWhenUnreachable: boolean;
  alwaysTold: boolean;
  reach?: Reach | undefined;
}

export class InstanceWatchSetting {
  constructor(
    private readonly settings: { rootUrl: string; instanceId: string; token: () => Promise<string> },
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private async root(method: 'GET' | 'PUT', body?: unknown): Promise<InstanceWatchView> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/watch`, {
      method,
      headers: { 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${await this.settings.token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const answer = rootAnswer(response.ok, response.status, await response.text());
    if (!response.ok) throw new RootRefused(response.status, answer.error ?? `root answered ${response.status}`);
    const view = answer.body as InstanceWatchView;
    return { notifyWhenUnreachable: view.notifyWhenUnreachable, alwaysTold: view.alwaysTold, ...(view.reach ? { reach: view.reach } : {}) };
  }

  read(): Promise<InstanceWatchView> {
    return this.root('GET');
  }

  set(notifyWhenUnreachable: boolean): Promise<InstanceWatchView> {
    return this.root('PUT', { notifyWhenUnreachable });
  }
}
