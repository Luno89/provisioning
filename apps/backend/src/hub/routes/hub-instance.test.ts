import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { objectWith } from '../../platform/lib/test-matchers.js';
import { HUB_AUDIENCE, hubInstancePart } from '../lib/hub.js';
import { RELAY_NAME_HEADER, RELAY_STATUS_HEADER, RELAY_TYPE_HEADER } from '../lib/hub-board.js';
import type { RelayAnswer, RelayCall } from '../services/HubRelay.js';
import type { SyncOrigin } from '../services/HubService.js';
import { callRouter } from '../testing/call-router.js';
import { hubInstanceRouter, type InstanceHub } from './hub-instance.js';

const root = identityKeysFrom(generateIdentityKey());
const stranger = identityKeysFrom(generateIdentityKey());
const succeeded = <T>(value: T) => ({ ok: true as const, value });
const ofAnn = matches<SyncOrigin>((origin) => origin.kind === 'instance' && origin.instanceId === 'inst-1' && origin.personId === 'ann' && origin.email === 'ann@example.com');

function site() {
  const hub = mock<InstanceHub>();
  const used = new Set<string>();
  const router = hubInstanceRouter({ hub, trusted: trustedKeys([publicKeyPem(root.publicKey)]), claim: async (jti) => (used.has(jti) ? false : Boolean(used.add(jti))) });
  const headersFor = (keys = root, who = { instance: 'inst-1', person: 'ann', email: 'ann@example.com' }, vouched = who): Record<string, string> => ({
    authorization: `Bearer ${issueMoveToken(keys, HUB_AUDIENCE, hubInstancePart(vouched.instance, vouched.person, vouched.email))}`,
    'x-koala-instance': who.instance,
    'x-koala-person': who.person,
    'x-koala-email': who.email,
  });
  const call = (route: Parameters<typeof callRouter>[2], headers = headersFor()) => callRouter(router, '/api/hub-instance', { ...route, headers: { ...headers, ...route.headers } });
  return { hub, call, headersFor };
}

describe('/api/hub-instance, who may ask', () => {
  it('turns away a call with no token, a token from another key, a token for another person, another address, or a second use', async () => {
    const { hub, call, headersFor } = site();
    hub.waitingRequests.mockResolvedValue(succeeded([]));
    const me = { instance: 'inst-1', person: 'ann', email: 'ann@example.com' };
    const attempts = [
      call({ path: '/projects/abc/requests' }, {}),
      call({ path: '/projects/abc/requests' }, headersFor(stranger)),
      call({ path: '/projects/abc/requests' }, headersFor(root, me, { ...me, person: 'eve' })),
      call({ path: '/projects/abc/requests' }, headersFor(root, me, { ...me, email: 'eve@example.com' })),
      call({ path: '/projects/abc/requests' }, { ...headersFor(), 'x-koala-person': '' }),
    ];
    for (const answer of await Promise.all(attempts)) expect([answer.status, answer.body]).toEqual([401, { error: 'only an instance root vouches for reaches this' }]);
    const once = headersFor();
    expect((await call({ path: '/projects/abc/requests' }, once)).status).toBe(200);
    expect((await call({ path: '/projects/abc/requests' }, once)).status).toBe(401);
    expect(hub.waitingRequests).toHaveBeenCalledTimes(1);
  });
});

describe('/api/hub-instance, sharing and syncing', () => {
  it('shares a project under a name and a group, as the instance of the person who vouched', async () => {
    const { hub, call } = site();
    hub.share.mockResolvedValue(succeeded({ view: { project: { id: 'abc' } } } as never));
    const answer = await call({ method: 'POST', path: '/share', json: { name: 'Shop', projectId: 'p1', group: 'acme' } });
    expect([answer.status, answer.body]).toEqual([200, { view: { project: { id: 'abc' } } }]);
    expect(hub.share).toHaveBeenCalledWith(ofAnn, { name: 'Shop', projectId: 'p1', group: 'acme' });
  });

  it('takes a project back', async () => {
    const { hub, call } = site();
    hub.unshare.mockResolvedValue(succeeded({ deleted: 'abc' }));
    expect((await call({ method: 'DELETE', path: '/projects/abc' })).body).toEqual({ deleted: 'abc' });
    expect(hub.unshare).toHaveBeenCalledWith(ofAnn, 'abc');
  });

  it('takes changes up and gives changes since a point down', async () => {
    const { hub, call, headersFor } = site();
    hub.receive.mockResolvedValue(succeeded({ through: 2 }));
    hub.changesSince.mockResolvedValue(succeeded({ changes: [], through: 9, members: [] }));
    expect((await call({ method: 'POST', path: '/projects/abc/changes', json: { changes: [{ kind: 'trees', id: 't1', deleted: true }] } })).body).toEqual({ through: 2 });
    expect(hub.receive).toHaveBeenCalledWith(ofAnn, 'abc', [{ kind: 'trees', id: 't1', deleted: true }]);
    await call({ path: '/projects/abc/changes?after=7' }, headersFor());
    expect(hub.changesSince).toHaveBeenLastCalledWith(ofAnn, 'abc', 7);
    await call({ path: '/projects/abc/changes' }, headersFor());
    expect(hub.changesSince).toHaveBeenLastCalledWith(ofAnn, 'abc', 0);
  });

  it('answers with the hub\'s refusal and its status', async () => {
    const { hub, call } = site();
    hub.receive.mockResolvedValue({ ok: false, status: 403, why: 'This project is worked on another instance.' });
    expect(await call({ method: 'POST', path: '/projects/abc/changes', json: { changes: [] } })).toMatchObject({ status: 403, body: { error: 'This project is worked on another instance.' } });
  });

  it('gives the requests waiting, takes them settled, and takes what is live', async () => {
    const { hub, call, headersFor } = site();
    hub.waitingRequests.mockResolvedValue(succeeded([]));
    hub.settleRequest.mockResolvedValue(succeeded({ id: 'r1' } as never));
    hub.putStatus.mockResolvedValue(succeeded({ at: 'now' }));
    expect((await call({ path: '/projects/abc/requests' })).body).toEqual([]);
    await call({ method: 'POST', path: '/projects/abc/requests/r1', json: { state: 'refused', why: 'no' } }, headersFor());
    expect(hub.settleRequest).toHaveBeenCalledWith(ofAnn, 'abc', 'r1', { state: 'refused', why: 'no' });
    await call({ method: 'PUT', path: '/projects/abc/status', json: { status: { at: '1', releases: [], runs: [], treeRuns: {} } } }, headersFor());
    expect(hub.putStatus).toHaveBeenCalledWith(ofAnn, 'abc', { at: '1', releases: [], runs: [], treeRuns: {} });
  });
});

describe('/api/hub-instance, the relay', () => {
  const asked: RelayCall = { id: 'c1', projectId: 'abc', op: 'files.list', args: { dir: '' }, as: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' } };

  it('hands the instance the call a member made', async () => {
    const { hub, call } = site();
    hub.takeRelay.mockResolvedValue(succeeded(asked));
    const answer = await call({ path: '/projects/abc/relay' });
    expect([answer.status, answer.body]).toEqual([200, asked]);
    expect(hub.takeRelay).toHaveBeenCalledWith(ofAnn, 'abc', objectWith({}));
  });

  it('hands over a call that carries an upload by its type and size, never the bytes', async () => {
    const { hub, call, headersFor } = site();
    hub.takeRelay.mockResolvedValue(succeeded({ ...asked, op: 'files.upload', upload: { stream: Readable.from(['x']), type: 'text/plain', size: 1 } }));
    expect((await call({ path: '/projects/abc/relay' })).body).toEqual({ ...asked, op: 'files.upload', upload: { type: 'text/plain', size: 1 } });
    hub.takeRelay.mockResolvedValue(succeeded({ ...asked, op: 'files.upload', upload: { stream: Readable.from(['x']), type: 'text/plain' } }));
    expect((await call({ path: '/projects/abc/relay' }, headersFor())).body).toEqual({ ...asked, op: 'files.upload', upload: { type: 'text/plain' } });
  });

  it('answers that no call is waiting once the instance hangs up its wait', async () => {
    const { hub, call } = site();
    hub.takeRelay.mockImplementation(async (_origin, _id, closed) => { await closed; return succeeded(undefined); });
    const answer = await call({ path: '/projects/abc/relay', hangUp: Promise.resolve() });
    expect([answer.status, answer.text]).toEqual([204, '']);
  });

  it('turns away the instance that is not the one the project is worked on', async () => {
    const { hub, call } = site();
    hub.takeRelay.mockResolvedValue({ ok: false, status: 403, why: 'This project is worked on another instance.' });
    expect(await call({ path: '/projects/abc/relay' })).toMatchObject({ status: 403, body: { error: 'This project is worked on another instance.' } });
  });

  it('streams the upload of a waiting call to the instance', async () => {
    const { hub, call } = site();
    hub.relayed.mockResolvedValue(succeeded({ ...asked, upload: { stream: Readable.from([Buffer.from('bytes')]), type: 'text/plain', size: 5 } }));
    const answer = await call({ path: '/relay/c1/upload' });
    expect([answer.status, answer.text, answer.headers['content-type'], answer.headers['content-length']]).toEqual([200, 'bytes', 'application/octet-stream', '5']);
    expect(hub.relayed).toHaveBeenCalledWith(ofAnn, 'c1');
  });

  it('streams an upload of unknown size without a length', async () => {
    const { hub, call } = site();
    hub.relayed.mockResolvedValue(succeeded({ ...asked, upload: { stream: Readable.from([Buffer.from('b')]), type: 'text/plain' } }));
    expect((await call({ path: '/relay/c1/upload' })).headers['content-length']).toBeUndefined();
  });

  it('says there is nothing to upload for a call that carries nothing, or that is no longer waiting', async () => {
    const { hub, call, headersFor } = site();
    hub.relayed.mockResolvedValueOnce(succeeded(asked));
    expect(await call({ path: '/relay/c1/upload' })).toMatchObject({ status: 404, body: { error: 'That call carries nothing to upload.' } });
    hub.relayed.mockResolvedValueOnce({ ok: false, status: 404, why: 'That call is no longer waiting.' });
    expect(await call({ path: '/relay/c1/upload' }, headersFor())).toMatchObject({ status: 404, body: { error: 'That call is no longer waiting.' } });
  });

  it('takes the instance\'s json answer with its status, and a bad gateway when it names none', async () => {
    const { hub, call, headersFor } = site();
    hub.answerRelay.mockResolvedValue(succeeded({ answered: 'c1' }));
    expect((await call({ method: 'POST', path: '/relay/c1', json: { status: 200, body: [1] } })).body).toEqual({ answered: 'c1' });
    expect(hub.answerRelay).toHaveBeenLastCalledWith(ofAnn, 'c1', { kind: 'json', status: 200, body: [1] });
    await call({ method: 'POST', path: '/relay/c1', json: { status: 'x' } }, headersFor());
    expect(hub.answerRelay).toHaveBeenLastCalledWith(ofAnn, 'c1', { kind: 'json', status: 502, body: null });
  });

  it('takes the instance\'s file as the stream it arrives as, with the type, name, size and status it said', async () => {
    const { hub, call } = site();
    const received: Buffer[] = [];
    let seen: RelayAnswer | undefined;
    hub.answerRelay.mockImplementation(async (_origin, _id, answer) => {
      seen = answer;
      if (answer.kind === 'stream') for await (const chunk of answer.stream) received.push(Buffer.from(chunk as Buffer));
      return succeeded({ answered: 'c1' });
    });
    const answer = await call({ method: 'POST', path: '/relay/c1/stream', bytes: Buffer.from('%PDF'), headers: { [RELAY_STATUS_HEADER]: '200', [RELAY_TYPE_HEADER]: 'application/pdf', [RELAY_NAME_HEADER]: 'my%20nda.pdf' } });
    expect([answer.status, answer.body]).toEqual([200, { answered: 'c1' }]);
    expect(Buffer.concat(received).toString()).toBe('%PDF');
    expect(seen).toMatchObject({ kind: 'stream', status: 200, type: 'application/pdf', name: 'my nda.pdf', size: 4 });
  });

  it('takes a file that says nothing of itself as a 200 of unknown type', async () => {
    const { hub, call } = site();
    let seen: RelayAnswer | undefined;
    hub.answerRelay.mockImplementation(async (_origin, _id, answer) => {
      seen = answer;
      if (answer.kind === 'stream') for await (const chunk of answer.stream) void chunk;
      return succeeded({ answered: 'c1' });
    });
    await call({ method: 'POST', path: '/relay/c1/stream', bytes: Buffer.from('x'), headers: { [RELAY_STATUS_HEADER]: '0' } });
    expect(seen).toMatchObject({ kind: 'stream', status: 200, type: 'application/octet-stream' });
    expect(seen).not.toHaveProperty('name');
  });

  it('refuses a file for a call that is not waiting', async () => {
    const { hub, call } = site();
    hub.answerRelay.mockResolvedValue({ ok: false, status: 404, why: 'That call is no longer waiting.' });
    expect(await call({ method: 'POST', path: '/relay/c1/stream', bytes: Buffer.from('x') })).toMatchObject({ status: 404, body: { error: 'That call is no longer waiting.' } });
  });
});
