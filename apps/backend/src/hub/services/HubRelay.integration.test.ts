import axios from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { HUB_AUDIENCE, hubInstancePart } from '../lib/hub.js';
import { memoryHubStore } from '../lib/hub-store.js';
import { hubInstanceRouter } from '../routes/hub-instance.js';
import { hubRouter } from '../routes/hub.js';
import { HubRelay, InstanceOffline, OFFLINE_AFTER_MS } from './HubRelay.js';
import { RemoteHub } from './HubRemote.js';
import { HubService } from './HubService.js';

const bo = { personId: 'bo', email: 'bo@example.com', role: 'collaborator' as const };
const harnesses: Harness[] = [];
const relays: HubRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) relay.stop();
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 300 && !ready(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('relaying a member\'s call to the owner\'s instance on a real timer', () => {
  it('fails the calls an instance took but never answered, and the ones queued, once it has stopped polling for good', async () => {
    let now = 0;
    const relay = new HubRelay(() => now, 20);
    relays.push(relay);
    let close!: () => void;
    const polling = relay.take('p', new Promise<void>((resolve) => { close = resolve; }));
    const taken = relay.call('p', 'turns', { turnId: 't' }, bo).catch((err: Error) => err);
    expect((await polling)?.op).toBe('turns');
    const queued = relay.call('p', 'extensions', {}, bo).catch((err: Error) => err);
    close();
    expect(relay.online('p')).toBe(true);

    now += OFFLINE_AFTER_MS + 1;
    const [first, second] = await Promise.all([taken, queued]);
    expect(first).toBeInstanceOf(InstanceOffline);
    expect((first as Error).message).toBe('The owner\'s instance went offline before it answered.');
    expect(second).toBeInstanceOf(InstanceOffline);
    expect(relay.online('p')).toBe(false);
    await expect(relay.call('p', 'extensions', {}, bo)).rejects.toThrow('The owner\'s instance is offline, so this cannot be read until it is back.');
  });

  it('keeps the calls of an instance that is polling again', async () => {
    let now = 0;
    const relay = new HubRelay(() => now, 20);
    relays.push(relay);
    const polling = relay.take('p', new Promise(() => undefined));
    const asked = relay.call('p', 'extensions', {}, bo);
    const call = await polling;
    void relay.take('p', new Promise(() => undefined));
    now += OFFLINE_AFTER_MS * 3;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(relay.online('p')).toBe(true);
    relay.answer(call!.id, { kind: 'json', status: 200, body: [] });
    expect(await asked).toEqual({ kind: 'json', status: 200, body: [] });
  });
});

describe('a member waiting on an instance that went away, over HTTP', () => {
  it('is told the instance went offline, with the hub answering 409 once the instance has stopped taking calls', async () => {
    const root = identityKeysFrom(generateIdentityKey());
    let now = 0;
    const relay = new HubRelay(() => now, 20);
    relays.push(relay);
    const hub = new HubService({ store: memoryHubStore(), invites: { send: async () => ({ link: 'l', emailed: false }) }, relay });
    const forInstance = await mountRouter({ prefix: '/api/hub-instance', router: async (db) => hubInstanceRouter({ hub, trusted: trustedKeys([publicKeyPem(root.publicKey)]), claim: (jti, expiresAt) => db.instances.claimHandoff(jti, expiresAt) }) });
    const forAnn = await mountRouter({ prefix: '/api/hub', user: { ...TEST_USER, id: 'ann', email: 'ann@example.com' }, router: async () => hubRouter({ hub }) });
    harnesses.push(forInstance, forAnn);
    const remote = new RemoteHub({ access: async () => ({ token: issueMoveToken(root, HUB_AUDIENCE, hubInstancePart('inst-ann', 'ann', 'ann@example.com')), hubUrl: forInstance.url(''), personId: 'ann', email: 'ann@example.com', instanceId: 'inst-ann' }) });
    const shared = await remote.share({ id: 'ann', email: 'ann@example.com' }, { id: 'p1', name: 'Shop', group: 'acme' });
    const link = { projectId: 'p1', ownerId: 'ann', hubProjectId: shared.hubProjectId, pulledThrough: 0, sharedAt: 't' };

    const stop = new AbortController();
    const taken: string[] = [];
    const instance = remote.take(link, stop.signal).then((call) => { if (call) taken.push(call.id); });
    await until(() => relay.online(shared.hubProjectId));

    const asked = axios.get(forAnn.url(`/api/hub/projects/${shared.hubProjectId}/live/extensions`), { validateStatus: () => true });
    await instance;
    expect(taken).toHaveLength(1);
    stop.abort();
    now += OFFLINE_AFTER_MS + 1;
    const answer = await asked;
    expect([answer.status, answer.data]).toEqual([409, { error: 'The owner\'s instance went offline before it answered.' }]);

    const later = await axios.get(forAnn.url(`/api/hub/projects/${shared.hubProjectId}/live/extensions`), { validateStatus: () => true });
    expect([later.status, later.data]).toEqual([409, { error: 'The owner\'s instance is offline, so this cannot be read until it is back.' }]);
  });
});
