import { rootAnswer } from '../lib/root-answer.js';

export interface InstanceGroupsSettings {
  rootUrl: string;
  instanceId: string;
  token: () => Promise<string>;
}

export class InstanceGroups {
  constructor(private readonly settings: InstanceGroupsSettings, private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  private async call<T>(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/groups${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${await this.settings.token()}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = rootAnswer(response.ok, response.status, await response.text());
    if (!response.ok) throw new Error(answer.error ?? `root did not answer about this instance's groups (${response.status})`);
    return answer.body as T;
  }

  async check(name: string): Promise<string | null> {
    const answer = await this.call<{ ok: boolean; problem?: string }>('GET', `/check?name=${encodeURIComponent(name)}`);
    return answer.ok ? null : answer.problem ?? `"${name}" cannot be used`;
  }

  async claim(projectId: string, name: string): Promise<void> {
    await this.call('PUT', '', { projectId, name });
  }

  async release(projectId: string): Promise<void> {
    await this.call('DELETE', `/${encodeURIComponent(projectId)}`);
  }
}
