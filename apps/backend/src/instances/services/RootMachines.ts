import { rootAnswer } from '../lib/root-answer.js';

export interface RootMachinesSettings {
  rootUrl: string;
  instanceId: string;
  token: () => Promise<string>;
}

export interface RootMachine {
  id: string;
  ownerId: string;
  name: string;
  rootDir: string;
  os?: string | undefined;
  meshIp?: string | undefined;
  createdAt: string;
  lastSeenAt?: string | undefined;
}

export class RootMachines {
  constructor(private readonly settings: RootMachinesSettings, private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  private async call(method: string, path: string, what: string, body: unknown = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/machines${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${await this.settings.token()}` },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    const answer = rootAnswer(response.ok, response.status, await response.text());
    if (!response.ok && response.status !== 404) throw new Error(`root would not ${what} (${response.status}): ${answer.error ?? 'no reason given'}`);
    return { ok: response.ok, status: response.status, body: answer.body };
  }

  async list(): Promise<RootMachine[]> {
    const { body } = await this.call('GET', '', 'list this instance owner\'s machines');
    return Array.isArray(body) ? body as RootMachine[] : [];
  }

  async createJoinCode(_ownerId: string): Promise<{ code: string; command: string; expiresAt: string }> {
    const { body } = await this.call('POST', '/join-code', 'make a command to add a machine');
    return body as { code: string; command: string; expiresAt: string };
  }

  async adopt(machines: readonly Record<string, unknown>[]): Promise<{ adopted: number }> {
    const { body } = await this.call('POST', '/adopt', 'take this instance\'s machines', { machines });
    return { adopted: typeof (body as { adopted?: unknown }).adopted === 'number' ? (body as { adopted: number }).adopted : 0 };
  }

  async remove(_ownerId: string, deviceId: string): Promise<boolean> {
    return (await this.call('DELETE', `/${encodeURIComponent(deviceId)}`, 'remove the machine')).ok;
  }
}
