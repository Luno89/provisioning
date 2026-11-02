import { http, HttpResponse } from 'msw';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { interceptHttp } from '../../platform/testing/http.js';
import { objectWith } from '../../platform/lib/test-matchers.js';
import type { HubAccess } from '../lib/hub.js';
import type { HubLink } from '../lib/hub-sync.js';
import { RELAY_NAME_HEADER, RELAY_STATUS_HEADER, RELAY_TYPE_HEADER } from '../lib/hub-board.js';
import { RemoteHub, RootHubAccess } from './HubRemote.js';

const HUB = 'https://hub.test';
const link: HubLink = { projectId: 'p1', ownerId: 'ann', hubProjectId: 'abc123', pulledThrough: 0, sharedAt: '2026-10-21T00:00:00Z' };
const access: HubAccess = { token: 'the-token', hubUrl: HUB, personId: 'ann', email: 'ann@example.com', instanceId: 'inst-1' };

interface Seen { method: string; path: string; headers: Record<string, string>; body: string }
const seen: Seen[] = [];

const record = async (request: Request): Promise<void> => {
  const url = new URL(request.url);
  seen.push({ method: request.method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers.entries()), body: request.body ? await request.text() : '' });
};

const answering = (method: 'get' | 'post' | 'put' | 'delete', path: string, respond: () => Response) => http[method](`${HUB}${path}`, async ({ request }) => {
  await record(request);
  return respond();
});

const server = interceptHttp();

function remote() {
  seen.length = 0;
  const root = mock<Pick<RootHubAccess, 'access'>>();
  root.access.mockResolvedValue(access);
  return { hub: new RemoteHub(root), root };
}

describe('asking root for a way to the hub', () => {
  const settings = { rootUrl: 'https://root.test', instanceId: 'inst-1', token: async () => 'service-token' };

  it('asks as the instance, with its service token, and hands back what root grants', async () => {
    server.use(http.post('https://root.test/api/instances/hub-token', async ({ request }) => {
      await record(request);
      return HttpResponse.json(access);
    }));
    seen.length = 0;
    expect(await new RootHubAccess(settings).access()).toEqual(access);
    expect(seen).toEqual([{ method: 'POST', path: '/api/instances/hub-token', headers: objectWith({ 'x-instance-id': 'inst-1', authorization: 'Bearer service-token' }) as Record<string, string>, body: '' }]);
  });

  it('says why root refused, and its status', async () => {
    server.use(http.post('https://root.test/api/instances/hub-token', () => HttpResponse.json({ error: 'this instance has no hub' }, { status: 409 })));
    await expect(new RootHubAccess(settings).access()).rejects.toThrow('root gave no way to the hub (409): this instance has no hub');
  });

  it('says so when root refuses without a reason it can read', async () => {
    server.use(http.post('https://root.test/api/instances/hub-token', () => new HttpResponse('<html>', { status: 502 })));
    await expect(new RootHubAccess(settings).access()).rejects.toThrow('root gave no way to the hub (502): no reason given');
  });

  it('does not take an answer without a token for a grant', async () => {
    server.use(http.post('https://root.test/api/instances/hub-token', () => HttpResponse.json({ hubUrl: HUB })));
    await expect(new RootHubAccess(settings).access()).rejects.toThrow('root gave no way to the hub (200): no reason given');
  });
});

describe('the owner\'s instance talking to the hub', () => {
  it('reads the requests waiting for the owner, vouching for the instance and the person in every call', async () => {
    server.use(answering('get', '/api/hub-instance/projects/abc123/requests', () => HttpResponse.json([{ id: 'r1' }])));
    const { hub } = remote();
    expect(await hub.requests(link)).toEqual([{ id: 'r1' }]);
    expect(seen).toEqual([{ method: 'GET', path: '/api/hub-instance/projects/abc123/requests', headers: objectWith({ authorization: 'Bearer the-token', 'x-koala-instance': 'inst-1', 'x-koala-person': 'ann', 'x-koala-email': 'ann@example.com' }) as Record<string, string>, body: '' }]);
  });

  it('settles a request with how it went', async () => {
    server.use(answering('post', '/api/hub-instance/projects/abc123/requests/r%2F1', () => HttpResponse.json({})));
    const { hub } = remote();
    await hub.settle(link, 'r/1', { state: 'refused', why: 'no' });
    expect(seen[0]).toMatchObject({ method: 'POST', body: JSON.stringify({ state: 'refused', why: 'no' }), headers: objectWith({ 'content-type': 'application/json' }) as Record<string, string> });
  });

  it('puts what is live on the hub', async () => {
    server.use(answering('put', '/api/hub-instance/projects/abc123/status', () => HttpResponse.json({ at: '1' })));
    const { hub } = remote();
    await hub.status(link, { at: '1', releases: [], runs: [], treeRuns: {} });
    expect(seen[0]).toMatchObject({ method: 'PUT', body: JSON.stringify({ status: { at: '1', releases: [], runs: [], treeRuns: {} } }) });
  });

  it('sends changes up and reads changes since a point down', async () => {
    server.use(
      answering('post', '/api/hub-instance/projects/abc123/changes', () => HttpResponse.json({ through: 4 })),
      answering('get', '/api/hub-instance/projects/abc123/changes', () => HttpResponse.json({ changes: [], through: 7 })),
    );
    const { hub } = remote();
    expect(await hub.push(link, [{ kind: 'trees', id: 't1', deleted: true }])).toEqual({ through: 4 });
    expect(JSON.parse(seen[0]!.body)).toEqual({ changes: [{ kind: 'trees', id: 't1', deleted: true }] });
    expect(await hub.pull(link, 3)).toEqual({ changes: [], through: 7 });
    expect(seen[1]!.path).toBe('/api/hub-instance/projects/abc123/changes?after=3');
  });

  it('throws with the hub\'s status and its reason when the hub refuses', async () => {
    server.use(answering('get', '/api/hub-instance/projects/abc123/requests', () => HttpResponse.json({ error: 'there is no such project' }, { status: 404 })));
    const { hub } = remote();
    const failure = await hub.requests(link).catch((err: Error & { status?: number }) => err);
    expect(failure).toMatchObject({ message: 'the hub answered 404: there is no such project', status: 404 });
  });

  it('says it had no reason when the hub refuses without one', async () => {
    server.use(answering('get', '/api/hub-instance/projects/abc123/requests', () => new HttpResponse('boom', { status: 500 })));
    const { hub } = remote();
    await expect(hub.requests(link)).rejects.toThrow('the hub answered 500: no reason given');
  });

  it('shares a project under a group and takes the repository the hub made for it', async () => {
    server.use(answering('post', '/api/hub-instance/share', () => HttpResponse.json({ view: { project: { id: 'abc123' } }, repo: { url: 'https://git.test/r.git', username: 'bot', token: 't' } })));
    const { hub } = remote();
    const shared = await hub.share({ id: 'ann', email: 'ann@example.com' }, { id: 'p1', name: 'Shop', group: 'acme' });
    expect(shared).toEqual({ hubProjectId: 'abc123', repo: { url: 'https://git.test/r.git', username: 'bot', token: 't' } });
    expect(JSON.parse(seen[0]!.body)).toEqual({ name: 'Shop', projectId: 'p1', group: 'acme' });
  });

  it('shares a project the hub keeps no repository for', async () => {
    server.use(answering('post', '/api/hub-instance/share', () => HttpResponse.json({ view: { project: { id: 'abc123' } } })));
    const { hub } = remote();
    expect(await hub.share({ id: 'ann', email: 'ann@example.com' }, { id: 'p1', name: 'Shop', group: 'acme' })).toEqual({ hubProjectId: 'abc123' });
  });

  it('takes a project back from the hub, and does not mind that it is already gone', async () => {
    server.use(answering('delete', '/api/hub-instance/projects/abc123', () => HttpResponse.json({ error: 'gone' }, { status: 404 })));
    const { hub } = remote();
    await hub.unshare('ann', 'abc123');
    expect(seen[0]).toMatchObject({ method: 'DELETE', path: '/api/hub-instance/projects/abc123' });
  });

  it('does mind when taking a project back fails for another reason', async () => {
    server.use(answering('delete', '/api/hub-instance/projects/abc123', () => HttpResponse.json({ error: 'busy' }, { status: 500 })));
    const { hub } = remote();
    await expect(hub.unshare('ann', 'abc123')).rejects.toThrow('the hub answered 500: busy');
  });

  it('says whether the hub can be reached through root, and why not', async () => {
    const reachable = remote();
    expect(await reachable.hub.reachable()).toBe(true);
    const root = mock<Pick<RootHubAccess, 'access'>>();
    root.access.mockRejectedValue(new Error('root said no'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await new RemoteHub(root).reachable()).toBe(false);
    expect(warn).toHaveBeenCalledWith('[hub] the hub cannot be reached through root: root said no');
    warn.mockRestore();
  });
});

describe('the hub handing the owner\'s instance what members asked of it', () => {
  const relay = '/api/hub-instance/projects/abc123/relay';

  it('hands over nothing when no call came while it listened', async () => {
    server.use(answering('get', relay, () => new HttpResponse(null, { status: 204 })));
    const { hub } = remote();
    expect(await hub.take(link, new AbortController().signal)).toBeUndefined();
  });

  it('hands over a call as the hub took it from a member', async () => {
    const call = { id: 'c1', op: 'files.list', args: { dir: '' }, as: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' } };
    server.use(answering('get', relay, () => HttpResponse.json(call)));
    const { hub } = remote();
    expect(await hub.take(link, new AbortController().signal)).toEqual(call);
  });

  it('hands over a call with an upload that is fetched from the hub when opened', async () => {
    const call = { id: 'c/1', op: 'files.upload', args: { path: 'a.txt' }, as: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, upload: { type: 'text/plain', size: 5 } };
    server.use(
      answering('get', relay, () => HttpResponse.json(call)),
      answering('get', '/api/hub-instance/relay/c%2F1/upload', () => new HttpResponse('hello', { headers: { 'content-type': 'application/octet-stream' } })),
    );
    const { hub } = remote();
    const taken = await hub.take(link, new AbortController().signal);
    expect(taken?.upload).toMatchObject({ type: 'text/plain', size: 5 });
    const chunks: Buffer[] = [];
    for await (const chunk of await taken!.upload!.open()) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });

  it('hands over an upload of unknown size without one', async () => {
    server.use(answering('get', relay, () => HttpResponse.json({ id: 'c1', op: 'files.upload', args: {}, as: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, upload: { type: 'text/plain' } })));
    const { hub } = remote();
    const taken = await hub.take(link, new AbortController().signal);
    expect(taken?.upload).not.toHaveProperty('size');
  });

  it('answers a call with json', async () => {
    server.use(answering('post', '/api/hub-instance/relay/c1', () => HttpResponse.json({ answered: 'c1' })));
    const { hub } = remote();
    await hub.answer(link, 'c1', { kind: 'json', status: 200, body: [1] });
    expect(JSON.parse(seen[0]!.body)).toEqual({ status: 200, body: [1] });
  });

  it('answers a call with a file, streamed with its type, name, size and status', async () => {
    server.use(answering('post', '/api/hub-instance/relay/c1/stream', () => HttpResponse.json({ answered: 'c1' })));
    const { hub } = remote();
    await hub.answer(link, 'c1', { kind: 'stream', status: 200, type: 'application/pdf', name: 'my nda.pdf', size: 3, stream: Readable.from([Buffer.from('pdf')]) });
    expect(seen[0]).toMatchObject({ method: 'POST', body: 'pdf', headers: objectWith({ 'content-type': 'application/octet-stream', [RELAY_STATUS_HEADER]: '200', [RELAY_TYPE_HEADER]: 'application/pdf', [RELAY_NAME_HEADER]: 'my%20nda.pdf', 'content-length': '3' }) as Record<string, string> });
  });

  it('answers with a file that has neither a name nor a known size', async () => {
    server.use(answering('post', '/api/hub-instance/relay/c1/stream', () => HttpResponse.json({ answered: 'c1' })));
    const { hub } = remote();
    await hub.answer(link, 'c1', { kind: 'stream', status: 200, type: 'text/plain', stream: Readable.from([Buffer.from('x')]) });
    expect(seen[0]!.headers).not.toHaveProperty(RELAY_NAME_HEADER);
  });
});
