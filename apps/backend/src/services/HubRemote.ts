import type { HubAccess } from '../lib/hub.js';
import type { HubSyncTransport } from './HubSyncService.js';
import type { HubSharing } from './ProjectSharingService.js';

export class RootHubAccess {
  constructor(private readonly settings: { rootUrl: string; instanceId: string; credential: string }, private readonly fetchImpl: typeof fetch = fetch) {}

  async access(): Promise<HubAccess> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/hub-token`, {
      method: 'POST',
      headers: { 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${this.settings.credential}` },
    });
    const answer = await response.json().catch(() => ({})) as HubAccess & { error?: string };
    if (!response.ok || !answer.token) throw new Error(`root gave no way to the hub (${response.status}): ${answer.error ?? 'no reason given'}`);
    return answer;
  }
}

export class RemoteHub implements HubSyncTransport, HubSharing {
  constructor(private readonly root: Pick<RootHubAccess, 'access'>, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const access = await this.root.access();
    const response = await this.fetchImpl(`${access.hubUrl}/api/hub-instance${path}`, {
      method,
      headers: {
        authorization: `Bearer ${access.token}`,
        'x-koala-instance': access.instanceId,
        'x-koala-person': access.personId,
        'x-koala-email': access.email,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw Object.assign(new Error(`the hub answered ${response.status}: ${answer.error ?? 'no reason given'}`), { status: response.status });
    return answer;
  }

  reachable = async (): Promise<boolean> => this.root.access().then(() => true, () => false);

  push: HubSyncTransport['push'] = (link, changes) => this.call('POST', `/projects/${encodeURIComponent(link.hubProjectId)}/changes`, { changes });

  pull: HubSyncTransport['pull'] = (link, after) => this.call('GET', `/projects/${encodeURIComponent(link.hubProjectId)}/changes?after=${after}`);

  share: HubSharing['share'] = async (_owner, project) => {
    const shared = await this.call<{ view: { project: { id: string } }; repo?: { url: string; username: string; token: string } }>('POST', '/share', { name: project.name, projectId: project.id });
    return { hubProjectId: shared.view.project.id, ...(shared.repo ? { repo: shared.repo } : {}) };
  };

  unshare: HubSharing['unshare'] = async (_ownerId, hubProjectId) => {
    await this.call('DELETE', `/projects/${encodeURIComponent(hubProjectId)}`).catch((err: Error & { status?: number }) => {
      if (err.status !== 404) throw err;
    });
  };
}
