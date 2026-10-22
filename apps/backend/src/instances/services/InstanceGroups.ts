export interface InstanceGroupsSettings {
  rootUrl: string;
  instanceId: string;
  credential: string;
}

export class InstanceGroups {
  constructor(private readonly settings: InstanceGroupsSettings, private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  private async call<T>(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/groups${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${this.settings.credential}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = await response.json().catch(() => ({})) as T & { error?: unknown };
    if (!response.ok) throw new Error(typeof answer.error === 'string' ? answer.error : `root did not answer about this instance's groups (${response.status})`);
    return answer;
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
