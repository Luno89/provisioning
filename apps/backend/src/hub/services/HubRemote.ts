import { Readable } from 'node:stream';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import type { ReadableStream as WebReadable } from 'node:stream/web';
import type { HubAccess } from '../lib/hub.js';
import type { HubSyncTransport } from './HubSyncService.js';
import type { HubSharing } from '../../projects/index.js';
import type { InstanceCall } from './HubInstanceWork.js';
import { RELAY_NAME_HEADER, RELAY_STATUS_HEADER, RELAY_TYPE_HEADER } from '../lib/hub-board.js';
import { refusalOf } from './hub-answers.js';
import { HUB_LINES_NAMESPACE } from '../lib/hub.js';
import type { DescribedCall } from '../lib/hub-lines.js';
import { REOPEN_FIRST_MS, REOPEN_MOST_MS, reopening, reportingFetch, stillDown, type DependencyReporter } from '../../platform/index.js';

export type HubLineConnect = (url: string, options: Partial<ManagerOptions & SocketOptions>) => Socket;

export class RootHubAccess {
  constructor(private readonly settings: { rootUrl: string; instanceId: string; token: () => Promise<string> }, private readonly fetchImpl: typeof fetch = fetch) {}

  async access(): Promise<HubAccess> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/hub-token`, {
      method: 'POST',
      headers: { 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${await this.settings.token()}` },
    });
    const answer = (response.ok ? await response.json() : await refusalOf(response)) as HubAccess & { error?: string };
    if (!response.ok || !answer.token) throw new Error(`root gave no way to the hub (${response.status}): ${answer.error ?? 'no reason given'}`);
    return answer;
  }
}

export class RemoteHub implements HubSyncTransport, HubSharing {
  constructor(
    private readonly root: Pick<RootHubAccess, 'access'>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly socketTo: HubLineConnect = io,
    private readonly log: (line: string) => void = (line) => console.warn(`[hub] ${line}`),
    private readonly reopenMs = REOPEN_FIRST_MS,
    private readonly reportsTo?: DependencyReporter | undefined,
  ) {}

  private lineFailure: string | undefined;

  lineProblem(): string | undefined {
    return this.lineFailure;
  }

  private lineFailed(reason: string): void {
    this.lineFailure = reason;
    this.reportsTo?.failed('hub', stillDown(reason));
  }

  private lineOpened(): void {
    this.lineFailure = undefined;
    this.reportsTo?.answered('hub');
  }

  private async send(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, init: { headers?: Record<string, string>; body?: RequestInit['body']; signal?: AbortSignal; duplex?: 'half' } = {}): Promise<Response> {
    const access = await this.root.access();
    const asked = this.reportsTo ? reportingFetch(this.reportsTo, 'hub', this.fetchImpl) : this.fetchImpl;
    const response = await asked(`${access.hubUrl}/api/hub-instance${path}`, {
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
      throw Object.assign(new Error(`the hub answered ${response.status}: ${(await refusalOf(response)).error ?? 'no reason given'}`), { status: response.status });
    }
    return response;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await response.json() as T;
  }

  private projectPath = (hubProjectId: string) => `/projects/${encodeURIComponent(hubProjectId)}`;

  requests: HubSyncTransport['requests'] = (link) => this.call('GET', `${this.projectPath(link.hubProjectId)}/requests`);

  settle: HubSyncTransport['settle'] = async (link, requestId, outcome) => {
    await this.call('POST', `${this.projectPath(link.hubProjectId)}/requests/${encodeURIComponent(requestId)}`, outcome);
  };

  status: HubSyncTransport['status'] = async (link, status) => {
    await this.call('PUT', `${this.projectPath(link.hubProjectId)}/status`, { status });
  };

  private callFrom(described: DescribedCall): InstanceCall {
    const { upload, ...call } = described;
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
  }

  connect: HubSyncTransport['connect'] = (line) => {
    let socket: Socket | undefined;
    let stopped = false;
    const reopen = reopening(this.reopenMs);
    let retry: NodeJS.Timeout | undefined;
    const again = (why: string) => {
      if (stopped) return;
      this.log(`the hub is not connected (${why}); connecting again in ${reopen.seconds} s`);
      retry = reopen.later(open);
    };
    const open = () => {
      this.root.access().then((first) => {
        if (stopped) return;
        let unused: HubAccess | undefined = first;
        const opened = this.socketTo(`${first.hubUrl.replace(/\/+$/, '')}${HUB_LINES_NAMESPACE}`, {
          transports: ['websocket'],
          reconnectionDelayMax: REOPEN_MOST_MS,
          auth: (send) => {
            const given = unused;
            unused = undefined;
            (given ? Promise.resolve(given) : this.root.access()).then(
              (access) => send({ instanceId: access.instanceId, personId: access.personId, email: access.email, token: access.token }),
              (err: Error) => { this.log(`root gave no way to the hub: ${err.message}`); send({}); },
            );
          },
        });
        socket = opened;
        opened.on('connect', () => { reopen.reset(); this.lineOpened(); line.connected(); });
        opened.on('call', (described: DescribedCall) => line.call(this.callFrom(described)));
        opened.on('changed', (hubProjectId: unknown) => line.changed(String(hubProjectId)));
        opened.on('connect_error', (err) => {
          if (opened.active) return;
          opened.close();
          socket = undefined;
          this.lineFailed(`the connection to it failed: ${err.message}`);
          again(err.message);
        });
        opened.on('disconnect', (reason) => {
          if (reason !== 'io server disconnect') return;
          opened.close();
          socket = undefined;
          this.lineFailed('it closed the connection');
          again('the hub closed the connection');
        });
      }, (err: Error) => again(err.message));
    };
    open();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      socket = undefined;
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

  reachable = async (): Promise<boolean> => this.root.access().then(() => true, (err: unknown) => {
    console.warn(`[hub] the hub cannot be reached through root: ${(err as Error).message}`);
    return false;
  });

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
