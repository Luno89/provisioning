import http from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import { Server as SocketServer } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';
import { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { harnessApp } from '../../platform/routes/test-harness.js';
import { HUB_AUDIENCE, hubInstancePart } from '../lib/hub.js';
import { memoryHubStore } from '../lib/hub-store.js';
import { diffRecord, type HubLink } from '../lib/hub-sync.js';
import { hubInstanceRouter, instanceOrigin } from '../routes/hub-instance.js';
import { hubRouter } from '../routes/hub.js';
import type { InstanceCall } from '../services/HubInstanceWork.js';
import { HubRelay } from '../services/HubRelay.js';
import { RemoteHub } from '../services/HubRemote.js';
import { HubService } from '../services/HubService.js';
import { wireHubLines } from './hub-lines.js';

const ann = { id: 'ann', email: 'ann@example.com' };
const closing: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closing.splice(0)) await close(); });

const next = <T>() => {
  let hand!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { hand = resolve; });
  return { promise, hand };
};

async function hubServer() {
  const db = await testDatabase();
  const root = identityKeysFrom(generateIdentityKey());
  const trusted = trustedKeys([publicKeyPem(root.publicKey)]);
  const claim = (jti: string, expiresAt: string) => db.instances.claimHandoff(jti, expiresAt);
  const hub = new HubService({ store: memoryHubStore(), invites: { send: async () => ({ link: 'l', emailed: false }) }, relay: new HubRelay() });
  const app = await harnessApp({ prefix: '/api/hub', router: () => hubRouter({ hub }) }, db, () => ann);
  app.use('/api/hub-instance', hubInstanceRouter({ hub, trusted, claim }));
  const server = http.createServer(app);
  const io = new SocketServer(server);
  wireHubLines(io, hub, (given) => instanceOrigin(given, trusted, claim));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closing.push(async () => { await io.close(); });
  const access = async () => ({ token: issueMoveToken(root, HUB_AUDIENCE, hubInstancePart('inst-ann', 'ann', ann.email)), hubUrl: url, personId: 'ann', email: ann.email, instanceId: 'inst-ann' });
  return { url, access, hub };
}

describe('the owner\'s instance and the hub, over one socket', () => {
  it('carries a member\'s call to the instance and its answer back, tells it what changed, and fails a waiting call at once when it goes', async () => {
    const { url, access } = await hubServer();
    const remote = new RemoteHub({ access }, fetch, undefined, () => undefined);
    const shared = await remote.share({ id: 'ann', email: ann.email }, { id: 'p1', name: 'Shop', group: 'acme' });
    const link: HubLink = { projectId: 'p1', ownerId: 'ann', hubProjectId: shared.hubProjectId, pulledThrough: 0, sharedAt: 't' };
    const channel = { id: 'c1', kind: 'channel', title: 'Shop', messages: [] };
    await remote.push(link, [{ kind: 'conversations', id: 'c1', patch: diffRecord(undefined, channel)! }]);

    const connected = next<void>();
    let call = next<InstanceCall>();
    const changed = next<string>();
    const disconnect = remote.connect({ connected: () => connected.hand(), call: (given) => call.hand(given), changed: (projectId) => changed.hand(projectId) });
    closing.push(async () => { disconnect(); });
    await connected.promise;

    const live = (path: string) => axios.get(`${url}/api/hub/projects/${shared.hubProjectId}/live/${path}`, { validateStatus: () => true });
    const answered = live('extensions');
    const first = await call.promise;
    expect(first).toMatchObject({ projectId: shared.hubProjectId, op: 'extensions' });
    await remote.answer(link, first.id, { kind: 'json', status: 200, body: ['grove'] });
    expect([(await answered).status, (await answered).data]).toEqual([200, ['grove']]);

    await axios.post(`${url}/api/hub/projects/${shared.hubProjectId}/conversations/c1/messages`, { content: 'is the shop live yet?' });
    expect(await changed.promise).toBe(shared.hubProjectId);

    call = next<InstanceCall>();
    const unanswered = live('extensions');
    await call.promise;
    disconnect();
    expect([(await unanswered).status, (await unanswered).data]).toEqual([409, { error: 'The owner\'s instance went offline before it answered.' }]);
    const later = await live('extensions');
    expect([later.status, later.data]).toEqual([409, { error: 'The owner\'s instance is offline, so this cannot be read until it is back.' }]);
  });

  it('refuses a connection root did not vouch for', async () => {
    const { url } = await hubServer();
    const refused = next<void>();
    const { io } = await import('socket.io-client');
    const probe = io(`${url}/hub-instances`, { transports: ['websocket'], reconnection: false, auth: { instanceId: 'inst-ann', personId: 'ann', email: ann.email, token: 'made-up' } });
    probe.on('connect_error', (err) => { expect(err.message).toBe('Unauthorized'); refused.hand(); });
    await refused.promise;
    probe.close();
  });
});
