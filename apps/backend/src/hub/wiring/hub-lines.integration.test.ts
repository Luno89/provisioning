import http from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import { Server as SocketServer } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';
import { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { harnessApp } from '../../platform/routes/test-harness.js';
import { HUB_AUDIENCE, hubInstancePart } from '../lib/hub.js';
import { memoryHubStore } from '../testing/memory-hub-store.js';
import { diffRecord, type HubLink } from '../lib/hub-sync.js';
import { hubInstanceRouter, instanceOrigin } from '../routes/hub-instance.js';
import { hubRouter } from '../routes/hub.js';
import { mock } from 'vitest-mock-extended';
import type { HubInstanceWork, InstanceCall } from '../services/HubInstanceWork.js';
import { HubSyncService } from '../services/HubSyncService.js';
import { HubRelay } from '../services/HubRelay.js';
import { RemoteHub } from '../services/HubRemote.js';
import { HubService } from '../services/HubService.js';
import { wireHubLines } from './hub-lines.js';
import { DependencyStates } from '../../platform/services/DependencyStates.js';

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
  return { url, access, hub, io };
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

  it('connects again by itself whenever root or the hub cannot be reached, each time with a fresh token from root', async () => {
    const { access, io } = await hubServer();
    const answers: Array<'away' | 'made-up' | 'good'> = ['away', 'made-up', 'good', 'away', 'good'];
    const asking = async () => {
      const answer = answers.shift() ?? 'good';
      if (answer === 'away') throw new Error('root is away');
      const given = await access();
      return answer === 'made-up' ? { ...given, token: 'made-up' } : given;
    };
    const said: string[] = [];
    const heard: string[] = [];
    const states = new DependencyStates({ process: 'backend', described: ['hub'], log: (line) => heard.push(line) });
    closing.push(async () => { states.stop(); });
    const remote = new RemoteHub({ access: asking }, fetch, undefined, (line) => said.push(line), 1, states);
    let connected = next<void>();
    const disconnect = remote.connect({ connected: () => connected.hand(), call: () => undefined, changed: () => undefined });
    closing.push(async () => { disconnect(); });

    await connected.promise;
    expect(said).toEqual([
      'the hub is not connected (root is away); connecting again in 0 s',
      'the hub is not connected (Unauthorized); connecting again in 0 s',
    ]);
    expect(heard).toEqual([
      '[dependencies] backend: the hub isn\'t answering: the connection to it failed: Unauthorized',
      '[dependencies] backend: the hub answers again',
    ]);
    expect(states.stateOf('hub').state).toBe('answering');

    connected = next<void>();
    for (const [, socket] of io.of('/hub-instances').sockets) socket.conn.close();
    await connected.promise;
    expect(said.slice(2)).toEqual([
      'root gave no way to the hub: root is away',
      'the hub is not connected (Unauthorized); connecting again in 0 s',
    ]);
    expect(answers).toEqual([]);
  });

  it('carries the hub\'s calls to the instance\'s own sync, which answers them and pulls what members changed', async () => {
    const { url, access } = await hubServer();
    const db = await testDatabase();
    const states = new DependencyStates({ process: 'backend', described: ['hub'], log: () => undefined });
    closing.push(async () => { states.stop(); });
    const remote = new RemoteHub({ access }, fetch, undefined, () => undefined, 1, states);
    states.wentDown('hub', 'it closed the connection', new Date().toISOString());
    const shared = await remote.share({ id: 'ann', email: ann.email }, { id: 'p1', name: 'Shop', group: 'acme' });
    expect(states.stateOf('hub')).toEqual({ state: 'answering' });
    const link: HubLink = { projectId: 'p1', ownerId: 'ann', hubProjectId: shared.hubProjectId, pulledThrough: 0, sharedAt: 't' };
    await db.hub.saveHubLink(link);
    await remote.push(link, [{ kind: 'conversations', id: 'c1', patch: diffRecord(undefined, { id: 'c1', kind: 'channel', title: 'Shop', messages: [] })! }]);

    const work = mock<HubInstanceWork>();
    work.handle.mockResolvedValue({ kind: 'json', status: 200, body: ['grove'] });
    const sync = new HubSyncService({ store: db.hub, transport: remote, origin: 'instance:inst-ann', work: () => work, log: () => undefined });
    closing.push(async () => { await sync.stop(); });
    const pulled = next<void>();
    const pull = remote.pull.bind(remote);
    remote.pull = async (asked, after) => { const answer = await pull(asked, after); if (answer.changes.length > 0) pulled.hand(); return answer; };
    const connected = next<void>();
    const connect = remote.connect.bind(remote);
    remote.connect = (line) => connect({ ...line, connected: () => { line.connected(); connected.hand(); } });
    await sync.start();
    await connected.promise;

    const live = await axios.get(`${url}/api/hub/projects/${shared.hubProjectId}/live/extensions`, { validateStatus: () => true });
    expect([live.status, live.data]).toEqual([200, ['grove']]);
    expect(work.handle).toHaveBeenCalledWith(expect.objectContaining({ hubProjectId: shared.hubProjectId }), expect.objectContaining({ op: 'extensions' }));

    await axios.post(`${url}/api/hub/projects/${shared.hubProjectId}/conversations/c1/messages`, { content: 'is it live yet?' });
    await pulled.promise;
  });
});
