export interface RootMeshKeysSettings {
  rootUrl: string;
  instanceId: string;
  credential: string;
}

export class RootMeshKeys {
  constructor(private readonly settings: RootMeshKeysSettings, private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async createPreAuthKey(_ownerId: string): Promise<{ key: string }> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/machine-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${this.settings.credential}` },
      body: '{}',
    });
    const body = await response.json().catch(() => ({})) as { preAuthKey?: unknown; error?: unknown };
    if (!response.ok || typeof body.preAuthKey !== 'string') {
      throw new Error(`root would not let a machine join the mesh (${response.status}): ${typeof body.error === 'string' ? body.error : 'no key came back'}`);
    }
    return { key: body.preAuthKey };
  }
}
