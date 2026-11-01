import { rootAnswer } from '../lib/root-answer.js';

export interface RootMeshKeysSettings {
  rootUrl: string;
  instanceId: string;
  token: () => Promise<string>;
}

export class RootMeshKeys {
  constructor(private readonly settings: RootMeshKeysSettings, private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async createPreAuthKey(_ownerId: string): Promise<{ key: string }> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/machine-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${await this.settings.token()}` },
      body: '{}',
    });
    const answer = rootAnswer(response.ok, response.status, await response.text());
    const { preAuthKey } = answer.body as { preAuthKey?: unknown };
    if (!response.ok || typeof preAuthKey !== 'string') {
      throw new Error(`root would not let a machine join the mesh (${response.status}): ${answer.error ?? 'no key came back'}`);
    }
    return { key: preAuthKey };
  }

  async removeNode(_ownerId: string, meshIp: string): Promise<void> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/machine-node`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${await this.settings.token()}` },
      body: JSON.stringify({ meshIp }),
    });
    if (!response.ok && response.status !== 404) {
      const answer = rootAnswer(response.ok, response.status, await response.text());
      throw new Error(`root would not take the machine off the mesh (${response.status}): ${answer.error ?? 'no reason given'}`);
    }
  }
}
