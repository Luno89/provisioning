import { Readable } from 'node:stream';
import type { ReadableStream as WebReadable } from 'node:stream/web';
import type { HubAccess } from '../lib/hub.js';
import type { HubSyncTransport } from './HubSyncService.js';
import type { HubSharing } from '../../projects/services/ProjectSharingService.js';
import type { InstanceCall } from './HubInstanceWork.js';
import { RELAY_NAME_HEADER, RELAY_STATUS_HEADER, RELAY_TYPE_HEADER } from '../lib/hub-board.js';

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

  private async send(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, init: { headers?: Record<string, string>; body?: RequestInit['body']; signal?: AbortSignal; duplex?: 'half' } = {}): Promise<Response> {
    const access = await this.root.access();
    const response = await this.fetchImpl(`${access.hubUrl}/api/hub-instance${path}`, {
      method,
      ...init,
      headers: {
        authorization: `Bearer ${access.token}`,
        'x-koala-instance': access.instanceId,
        'x-koala-person': access.personId,
        'x-koala-email': access.email,
        ...(init.headers ?? {}),
      },
    } as RequestInit);
    if (!response.ok) {
      const answer = await response.json().catch(() => ({})) as { error?: string };
      throw Object.assign(new Error(`the hub answered ${response.status}: ${answer.error ?? 'no reason given'}`), { status: response.status });
    }
    return response;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await response.json().catch(() => ({})) as T;
  }

  private projectPath = (hubProjectId: string) => `/projects/${encodeURIComponent(hubProjectId)}`;

  requests: HubSyncTransport['requests'] = (link) => this.call('GET', `${this.projectPath(link.hubProjectId)}/requests`);

  settle: HubSyncTransport['settle'] = async (link, requestId, outcome) => {
    await this.call('POST', `${this.projectPath(link.hubProjectId)}/requests/${encodeURIComponent(requestId)}`, outcome);
  };

  status: HubSyncTransport['status'] = async (link, status) => {
    await this.call('PUT', `${this.projectPath(link.hubProjectId)}/status`, { status });
  };

  take: HubSyncTransport['take'] = async (link, signal) => {
    const response = await this.send('GET', `${this.projectPath(link.hubProjectId)}/relay`, { signal });
    if (response.status === 204) return undefined;
    const { upload, ...call } = await response.json() as Omit<InstanceCall, 'upload'> & { upload?: { type: string; size?: number } };
    return {
      ...call,
      ...(upload ? {
        upload: {
          type: upload.type,
          ...(upload.size !== undefined ? { size: upload.size } : {}),
          open: async () => {
            const body = (await this.send('GET', `/relay/${encodeURIComponent(call.id)}/upload`)).body;
            if (!body) throw new Error('the hub sent no file');
            return Readable.fromWeb(body as unknown as WebReadable);
          },
        },
      } : {}),
    };
  };

  answer: HubSyncTransport['answer'] = async (_link, callId, answer) => {
    if (answer.kind === 'json') {
      await this.call('POST', `/relay/${encodeURIComponent(callId)}`, { status: answer.status, body: answer.body });
      return;
    }
    await this.send('POST', `/relay/${encodeURIComponent(callId)}/stream`, {
      headers: {
        'content-type': 'application/octet-stream',
        [RELAY_STATUS_HEADER]: String(answer.status),
        [RELAY_TYPE_HEADER]: answer.type,
        ...(answer.name ? { [RELAY_NAME_HEADER]: encodeURIComponent(answer.name) } : {}),
        ...(answer.size !== undefined ? { 'content-length': String(answer.size) } : {}),
      },
      body: Readable.toWeb(answer.stream) as unknown as RequestInit['body'],
      duplex: 'half',
    });
  };

  reachable = async (): Promise<boolean> => this.root.access().then(() => true, () => false);

  push: HubSyncTransport['push'] = (link, changes) => this.call('POST', `/projects/${encodeURIComponent(link.hubProjectId)}/changes`, { changes });

  pull: HubSyncTransport['pull'] = (link, after) => this.call('GET', `/projects/${encodeURIComponent(link.hubProjectId)}/changes?after=${after}`);

  share: HubSharing['share'] = async (_owner, project) => {
    const shared = await this.call<{ view: { project: { id: string } }; repo?: { url: string; username: string; token: string } }>('POST', '/share', { name: project.name, projectId: project.id, group: project.group });
    return { hubProjectId: shared.view.project.id, ...(shared.repo ? { repo: shared.repo } : {}) };
  };

  unshare: HubSharing['unshare'] = async (_ownerId, hubProjectId) => {
    await this.call('DELETE', `/projects/${encodeURIComponent(hubProjectId)}`).catch((err: Error & { status?: number }) => {
      if (err.status !== 404) throw err;
    });
  };
}
