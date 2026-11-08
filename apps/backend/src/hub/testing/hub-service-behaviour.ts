import { objectWith } from '../../platform/lib/test-matchers.js';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { HubService } from '../services/HubService.js';
import { HubRelay, type RelayCall } from '../services/HubRelay.js';
import type { HubStore } from '../lib/hub-store.js';

export function hubServiceBehaviour(make: () => Promise<HubStore>): void {
  const ann = { id: 'ann', email: 'ann@example.com' };
  const bo = { id: 'bo', email: 'bo@example.com' };
  const cy = { id: 'cy', email: 'cy@example.com' };
  const eve = { id: 'eve', email: 'eve@example.com' };

  async function setUp() {
    const store = await make();
    const send = vi.fn(async (request: { join: string }) => ({ link: `http://root/#/join?project=${request.join}`, emailed: true }));
    const hub = new HubService({ store, invites: { send }, now: () => 'now' });
    const tokenOf = (call: number) => (send.mock.calls[call]![0] as { join: string }).join;
    return { hub, store, send, tokenOf };
  }

  const valueOf = <T>(outcome: { ok: true; value: T } | { ok: false; why: string }): T => {
    if (!outcome.ok) throw new Error(outcome.why);
    return outcome.value;
  };

  describe('a shared project and its people', () => {
    it('makes its maker the owner, invites by email with a role, and lets in only the address invited', async () => {
      const { hub, send, tokenOf } = await setUp();
      const shop = valueOf(await hub.create(ann, { name: ' Shop ', origin: { projectId: 'p1' } }));
      expect(shop).toMatchObject({ project: { name: 'Shop', createdBy: 'ann', origin: { projectId: 'p1' } }, role: 'owner', members: [{ personId: 'ann', role: 'owner' }] });
      const id = shop.project.id;

      expect(valueOf(await hub.invite(ann, id, { email: 'Bo@Example.com', role: 'collaborator' }))).toMatchObject({ email: 'bo@example.com', role: 'collaborator', emailed: true });
      expect(send).toHaveBeenCalledWith(objectWith({ email: 'bo@example.com', inviterEmail: 'ann@example.com', projectName: 'Shop', role: 'collaborator' }), objectWith({ id: 'ann' }));
      expect(valueOf(await hub.view('ann', id)).invites).toEqual([{ projectId: id, email: 'bo@example.com', role: 'collaborator', invitedBy: 'ann', createdAt: 'now' }]);

      expect(await hub.accept(eve, tokenOf(0))).toMatchObject({ ok: false, status: 403, why: 'This invite is for bo@example.com; sign in as that address to take it.' });
      expect(valueOf(await hub.invitation(bo, tokenOf(0)))).toEqual({ projectName: 'Shop', role: 'collaborator', email: 'bo@example.com', forYou: true });
      expect(valueOf(await hub.accept(bo, tokenOf(0)))).toMatchObject({ role: 'collaborator', members: [{ personId: 'ann' }, { personId: 'bo' }] });
      expect(await hub.accept(bo, tokenOf(0))).toMatchObject({ ok: false, status: 404 });
      expect((await hub.mine('bo')).map((entry) => [entry.project.name, entry.role])).toEqual([['Shop', 'collaborator']]);
    });

    it('gives each role only what it may do', async () => {
      const { hub, tokenOf } = await setUp();
      const id = valueOf(await hub.create(ann, { name: 'Shop' })).project.id;
      await hub.invite(ann, id, { email: 'bo@example.com', role: 'collaborator' });
      await hub.invite(ann, id, { email: 'cy@example.com', role: 'client' });
      await hub.accept(bo, tokenOf(0));
      await hub.accept(cy, tokenOf(1));

      const client = valueOf(await hub.view('cy', id));
      expect(client.can).toEqual(['see-project', 'see-people', 'pin-and-comment', 'ask-koala']);
      expect(client.invites).toBeUndefined();
      expect(valueOf(await hub.view('bo', id)).can).toContain('approve-changes');
      expect(await hub.invite(bo, id, { email: 'dee@example.com', role: 'owner' })).toMatchObject({ ok: false, status: 403 });
      expect(await hub.changeRole('bo', id, 'cy', 'owner')).toMatchObject({ ok: false, status: 403 });
      expect(await hub.remove('cy', id, 'bo')).toMatchObject({ ok: false, status: 403 });
    });

    it('shows nothing of a project to anyone not on it, even with its id, and refuses ids that are not ids', async () => {
      const { hub } = await setUp();
      const id = valueOf(await hub.create(ann, { name: 'Shop' })).project.id;
      for (const outcome of [await hub.view('eve', id), await hub.invite(eve, id, { email: 'x@example.com', role: 'owner' }), await hub.changeRole('eve', id, 'ann', 'client'), await hub.remove('eve', id, 'ann'), await hub.view('ann', '../admin')]) {
        expect(outcome).toEqual({ ok: false, status: 404, why: 'There is no such project, or you are not on it.' });
      }
      expect(await hub.mine('eve')).toEqual([]);
    });

    it('keeps one owner, lets people leave, and takes an invite back', async () => {
      const { hub, tokenOf } = await setUp();
      const id = valueOf(await hub.create(ann, { name: 'Shop' })).project.id;
      await hub.invite(ann, id, { email: 'bo@example.com', role: 'collaborator' });
      await hub.accept(bo, tokenOf(0));
      expect(await hub.remove('ann', id, 'ann')).toMatchObject({ ok: false, why: 'the last owner cannot leave; make someone else an owner first' });
      expect(await hub.changeRole('ann', id, 'ann', 'client')).toMatchObject({ ok: false, status: 400 });
      expect(valueOf(await hub.changeRole('ann', id, 'bo', 'owner')).members?.map((member) => member.role)).toEqual(['owner', 'owner']);
      expect(await hub.remove('ann', id, 'ann')).toEqual({ ok: true, value: { removed: 'ann' } });
      expect(await hub.view('ann', id)).toMatchObject({ ok: false, status: 404 });
      expect(await hub.mine('ann')).toEqual([]);

      await hub.invite(bo, id, { email: 'cy@example.com', role: 'client' });
      expect(await hub.takeBack('bo', id, 'CY@example.com')).toEqual({ ok: true, value: { email: 'cy@example.com' } });
      expect(await hub.accept(cy, tokenOf(1))).toMatchObject({ ok: false, status: 404 });
    });

    it('opens the shared project a project already has rather than making a second', async () => {
      const { hub } = await setUp();
      const first = valueOf(await hub.create(ann, { name: 'Shop', origin: { instanceId: 'i1', projectId: 'p1' } }));
      expect(valueOf(await hub.create(ann, { name: 'Shop again', origin: { instanceId: 'i1', projectId: 'p1' } })).project.id).toBe(first.project.id);
      expect(valueOf(await hub.create(ann, { name: 'Other', origin: { instanceId: 'i1', projectId: 'p2' } })).project.id).not.toBe(first.project.id);
    });

    it('lets only an owner delete a project, by typing its name, and leaves nothing of it', async () => {
      const { hub, store, tokenOf } = await setUp();
      const id = valueOf(await hub.create(ann, { name: 'Shop' })).project.id;
      await hub.invite(ann, id, { email: 'bo@example.com', role: 'collaborator' });
      await hub.accept(bo, tokenOf(0));
      await hub.invite(ann, id, { email: 'cy@example.com', role: 'client' });
      expect(await hub.delete('bo', id, 'Shop')).toMatchObject({ ok: false, status: 403 });
      expect(await hub.delete('eve', id, 'Shop')).toMatchObject({ ok: false, status: 404 });
      expect(await hub.delete('ann', id, 'shop')).toMatchObject({ ok: false, status: 400 });
      expect(await hub.delete('ann', id, 'Shop')).toEqual({ ok: true, value: { deleted: id } });
      expect([await hub.mine('ann'), await hub.mine('bo'), await store.getProject(id), await store.projectOfInvite(tokenOf(1)), await store.project(id).members()]).toEqual([[], [], undefined, undefined, []]);
    });

    it('lets a person go from every project when their account goes: deleting those only they are on, leaving the rest, refused while they alone own one others are on', async () => {
      const { hub, store, tokenOf } = await setUp();
      const alone = valueOf(await hub.create(ann, { name: 'Alone' })).project.id;
      const shop = valueOf(await hub.create(ann, { name: 'Shop' })).project.id;
      const guest = valueOf(await hub.create(bo, { name: 'Guest' })).project.id;
      await hub.invite(ann, shop, { email: 'bo@example.com', role: 'collaborator' });
      await hub.accept(bo, tokenOf(0));
      await hub.invite(bo, guest, { email: 'ann@example.com', role: 'client' });
      await hub.accept(ann, tokenOf(1));
      await hub.invite(ann, shop, { email: 'cy@example.com', role: 'client' });

      expect(await hub.leaving('ann')).toEqual({ blockers: ['you are the only owner of the shared project "Shop", which others are on; make one of them an owner first'], deletes: ['Alone'], leaves: ['Guest'] });
      await expect(hub.letGo('ann')).rejects.toThrow(/only owner of the shared project "Shop"/);
      expect(await store.getProject(alone)).toBeDefined();

      await hub.changeRole('ann', shop, 'bo', 'owner');
      expect((await hub.leaving('ann')).blockers).toEqual([]);
      const done = await hub.letGo('ann');
      expect(done.deleted).toEqual([alone]);
      expect(done.left.sort()).toEqual([guest, shop].sort());
      expect([await hub.mine('ann'), await store.getProject(alone), await store.projectOfInvite(tokenOf(2))]).toEqual([[], undefined, undefined]);
      expect(valueOf(await hub.view('bo', shop)).members?.map((member) => member.personId)).toEqual(['bo']);
      expect(valueOf(await hub.view('bo', guest)).members?.map((member) => member.personId)).toEqual(['bo']);
    });

    it('takes changes only from the owner\'s own instance, in order, and hands back what changed since a point', async () => {
      const { hub, store, tokenOf } = await setUp();
      const id = valueOf(await hub.create(ann, { name: 'Shop', origin: { instanceId: 'i-ann', projectId: 'p1' } })).project.id;
      await hub.invite(ann, id, { email: 'bo@example.com', role: 'owner' });
      await hub.accept(bo, tokenOf(0));
      const fromAnn = { kind: 'instance' as const, personId: 'ann', instanceId: 'i-ann' };

      expect(valueOf(await hub.receive(fromAnn, id, [
        { kind: 'leaves', id: 'l1', patch: { set: { title: 'Checkout', status: 'pending' } } },
        { kind: 'leaves', id: 'l1', patch: { set: { status: 'running' } } },
        { kind: 'leaves', id: 'l2', patch: { set: { title: 'Gone' } } },
        { kind: 'leaves', id: 'l2', deleted: true },
      ]))).toEqual({ through: 4 });
      expect(await store.project(id).records('leaves')).toEqual([{ id: 'l1', title: 'Checkout', status: 'running' }]);
      const since = valueOf(await hub.changesSince(fromAnn, id, 2));
      expect([since.through, since.changes.map((entry) => [entry.seq, entry.origin])]).toEqual([4, [[3, 'instance:i-ann'], [4, 'instance:i-ann']]]);

      for (const origin of [{ ...fromAnn, instanceId: 'i-other' }, { kind: 'instance' as const, personId: 'bo', instanceId: 'i-ann' }, { kind: 'person' as const, personId: 'ann' }]) {
        expect((await hub.receive(origin, id, [{ kind: 'leaves', id: 'l1', deleted: true }])).ok).toBe(false);
      }
      expect(await hub.receive({ kind: 'instance', personId: 'eve', instanceId: 'i-ann' }, id, [])).toMatchObject({ status: 404 });
      expect(await hub.receive(fromAnn, id, [{ kind: 'secrets', id: 'x', deleted: true }])).toMatchObject({ status: 400 });
      expect(await store.project(id).records('leaves')).toHaveLength(1);

      expect(await hub.changeRole('bo', id, 'ann', 'collaborator')).toMatchObject({ ok: false, status: 400 });
      expect(await hub.remove('bo', id, 'ann')).toMatchObject({ ok: false, status: 400 });
      expect(await hub.remove('ann', id, 'ann')).toMatchObject({ ok: false, status: 400 });
      expect(valueOf(await hub.receive(fromAnn, id, [{ kind: 'leaves', id: 'l3', patch: { set: { title: 'Still syncing' } } }]))).toEqual({ through: 5 });
      expect(valueOf(await hub.changeRole('ann', id, 'bo', 'collaborator')).members?.find((member) => member.personId === 'bo')?.role).toBe('collaborator');
    });

    it('is shared only from an instance, with a repository on the hub, and is taken back only by that instance, which deletes everything of it', async () => {
      const repos = { create: vi.fn(async (id: string) => ({ url: `http://gitea/shared-${id}/project.git`, username: `shared-${id}-bot`, token: 't' })), remove: vi.fn(async () => undefined), files: async () => [], read: async () => null };
      const store = await make();
      const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) }, repos });
      const fromAnn = { kind: 'instance' as const, personId: 'ann', instanceId: 'i-ann', email: 'ann@example.com' };
      expect(await hub.share({ kind: 'person', personId: 'ann' }, { name: 'Shop', projectId: 'p1' })).toMatchObject({ ok: false, status: 403 });
      const shared = valueOf(await hub.share(fromAnn, { name: 'Shop', projectId: 'p1' }));
      expect(shared.view).toMatchObject({ role: 'owner', project: { name: 'Shop', createdBy: 'ann', origin: { instanceId: 'i-ann', projectId: 'p1' } } });
      expect(shared.repo?.url).toBe(`http://gitea/shared-${shared.view.project.id}/project.git`);
      expect(valueOf(await hub.share(fromAnn, { name: 'Shop', projectId: 'p1' })).view.project.id).toBe(shared.view.project.id);

      expect(await hub.unshare({ ...fromAnn, instanceId: 'i-other' }, shared.view.project.id)).toMatchObject({ ok: false, status: 403 });
      expect(valueOf(await hub.unshare(fromAnn, shared.view.project.id))).toEqual({ deleted: shared.view.project.id });
      expect(repos.remove).toHaveBeenCalledWith(shared.view.project.id);
      expect([await store.getProject(shared.view.project.id), await hub.mine('ann')]).toEqual([undefined, []]);
    });

    it('keeps the group the sharer named, so everyone on the project sees what its apps are addressed under', async () => {
      const hub = new HubService({ store: await make(), invites: { send: async () => ({ link: 'l', emailed: false }) } });
      const fromAnn = { kind: 'instance' as const, personId: 'ann', instanceId: 'i-ann', email: 'ann@example.com' };
      expect(await hub.share(fromAnn, { name: 'Shop', projectId: 'p1', group: 'ac-me' })).toMatchObject({ ok: false, status: 400 });
      const shared = valueOf(await hub.share(fromAnn, { name: 'Shop', projectId: 'p1', group: 'acme' }));
      expect(shared.view.project.group).toBe('acme');
      expect(valueOf(await hub.view('ann', shared.view.project.id)).project.group).toBe('acme');
      expect((await hub.mine('ann'))[0]?.project.group).toBe('acme');
      expect(valueOf(await hub.share(fromAnn, { name: 'Other', projectId: 'p2' })).view.project.group).toBeUndefined();
    });
  });

  describe('an invite root will not send', () => {
    it('is refused with root\'s reason, and leaves no invite behind', async () => {
      const store = await make();
      const hub = new HubService({ store, invites: { send: async () => ({ refused: 'You have sent 20 project invites in the last hour, the most an hour allows; try again in 5 minutes.' }) }, now: () => 'now' });
      const id = valueOf(await hub.create(ann, { name: 'Shop' })).project.id;
      expect(await hub.invite(ann, id, { email: 'cy@example.com', role: 'client' })).toEqual({ ok: false, status: 429, why: 'You have sent 20 project invites in the last hour, the most an hour allows; try again in 5 minutes.' });
      expect(await store.project(id).invites()).toEqual([]);
      expect(valueOf(await hub.view('ann', id)).invites).toEqual([]);
    });

    it('leaves no invite behind when root cannot be asked, and says why', async () => {
      const store = await make();
      const hub = new HubService({ store, invites: { send: async () => { throw new Error('root did not answer'); } }, now: () => 'now' });
      const id = valueOf(await hub.create(ann, { name: 'Shop' })).project.id;
      await expect(hub.invite(ann, id, { email: 'cy@example.com', role: 'client' })).rejects.toThrow('root did not answer');
      expect(await store.project(id).invites()).toEqual([]);
      expect(valueOf(await hub.view('ann', id)).invites).toEqual([]);
    });
  });

  describe('taking someone off a shared project ends what Koala was doing for them', () => {
    async function withMember(hub: HubService, tokenOf: (call: number) => string): Promise<string> {
      const id = valueOf(await hub.create(ann, { name: 'Shop' })).project.id;
      await hub.invite(ann, id, { email: 'bo@example.com', role: 'collaborator' });
      await hub.accept(bo, tokenOf(0));
      return id;
    }

    it('leaves the owner\'s instance a removal to carry out, kept off the members\' board', async () => {
      const { hub, store, tokenOf } = await setUp();
      const id = await withMember(hub, tokenOf);

      expect(valueOf(await hub.remove('ann', id, 'bo'))).toEqual({ removed: 'bo' });
      const waiting = await store.project(id).requests();
      expect(waiting).toEqual([objectWith({ kind: 'member-removed', input: { personId: 'bo' }, by: objectWith({ personId: 'ann' }), state: 'waiting' })]);
      expect(valueOf(await hub.boardView('ann', id)).requests).toEqual([]);
    });
  });

  describe('a member working a project shared from the owner\'s instance', () => {
    const fromAnn = { kind: 'instance' as const, personId: 'ann', instanceId: 'i-ann', email: 'ann@example.com' };
    const now = '2026-10-21T00:00:00Z';
    const lineOf = () => {
      const calls: RelayCall[] = [];
      const changed: string[] = [];
      let handed!: (call: RelayCall) => void;
      const first = new Promise<RelayCall>((resolve) => { handed = resolve; });
      return { calls, changed, first, line: { call: (call: RelayCall) => { calls.push(call); handed(call); }, changed: (projectId: string) => { changed.push(projectId); } } };
    };

    async function shared(withRelay = true) {
      const store = await make();
      const relay = withRelay ? new HubRelay() : undefined;
      const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) }, ...(relay ? { relay } : {}), now: () => now });
      const id = valueOf(await hub.share(fromAnn, { name: 'Shop', projectId: 'p1' })).view.project.id;
      for (const [personId, role] of [['cy', 'client'], ['bo', 'collaborator']] as const) {
        await store.project(id).saveMember({ personId, email: `${personId}@example.com`, role, joinedAt: now });
        await store.addMembership(personId, id);
      }
      const onHub = store.project(id);
      await onHub.putRecord('conversations', { id: 'channel-p1', kind: 'channel', messages: [] });
      await onHub.putRecord('conversations', { id: 'story-l1', kind: 'item', messages: [] });
      await onHub.putRecord('branches', { id: 'b1', treeId: 't1' });
      await onHub.putRecord('leaves', { id: 'l1', branchId: 'b1' });
      await onHub.putRecord('leaves', { id: 'l2', branchId: 'b1' });
      return { hub, store, relay, id, onHub };
    }

    describe('what the owner\'s instance reads and settles', () => {
      it('lists only the requests still waiting, to the owner\'s own instance', async () => {
        const { hub, id, onHub } = await shared();
        const waiting = valueOf(await hub.request(bo, id, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'] }));
        await onHub.saveRequest({ ...waiting, id: 'old', state: 'done' });
        expect(valueOf(await hub.waitingRequests(fromAnn, id)).map((request) => request.id)).toEqual([waiting.id]);
        expect(await hub.waitingRequests({ ...fromAnn, instanceId: 'i-other' }, id)).toMatchObject({ ok: false, status: 403 });
        expect(await hub.waitingRequests({ ...fromAnn, personId: 'eve' }, id)).toMatchObject({ ok: false, status: 404 });
      });

      it('settles a request as done or refused with a reason, and only one that exists', async () => {
        const { hub, id, onHub } = await shared();
        const waiting = valueOf(await hub.request(bo, id, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'] }));
        expect(valueOf(await hub.settleRequest(fromAnn, id, waiting.id, { state: 'refused', why: 'the story moved' }))).toMatchObject({ state: 'refused', why: 'the story moved', settledAt: now });
        expect((await onHub.requests())[0]).toMatchObject({ state: 'refused', why: 'the story moved' });
        const another = valueOf(await hub.request(bo, id, { kind: 'order-stories', branchId: 'b1', leafIds: ['l1', 'l2'] }));
        expect(valueOf(await hub.settleRequest(fromAnn, id, another.id, { state: 'done', why: '' }))).not.toHaveProperty('why');
        expect(await hub.settleRequest(fromAnn, id, waiting.id, { state: 'maybe' })).toMatchObject({ ok: false, status: 400 });
        expect(await hub.settleRequest(fromAnn, id, 'nope', { state: 'done' })).toMatchObject({ ok: false, status: 404 });
        expect(await hub.settleRequest({ ...fromAnn, instanceId: 'i-other' }, id, waiting.id, { state: 'done' })).toMatchObject({ ok: false, status: 403 });
      });

      it('keeps what is live as the instance reports it, stamped with when the hub heard', async () => {
        const { hub, id, onHub } = await shared();
        expect(valueOf(await hub.putStatus(fromAnn, id, { releases: [{ id: 'r1' }], runs: [], treeRuns: { t1: { state: 'idle' } }, addresses: { app: 'x' }, at: 'ignored' }))).toEqual({ at: now });
        expect(await onHub.status()).toEqual({ at: now, releases: [{ id: 'r1' }], runs: [], treeRuns: { t1: { state: 'idle' } }, addresses: { app: 'x' } });
        await hub.putStatus(fromAnn, id, { releases: [], runs: [], treeRuns: {} });
        expect(await onHub.status()).not.toHaveProperty('addresses');
      });

      it('turns away a status that does not carry the releases, builds and tree runs', async () => {
        const { hub, id } = await shared();
        for (const status of [undefined, {}, { releases: [], runs: [] }, { releases: [], runs: [], treeRuns: 'x' }]) {
          expect(await hub.putStatus(fromAnn, id, status)).toMatchObject({ ok: false, status: 400 });
        }
        expect(await hub.putStatus({ ...fromAnn, instanceId: 'i-other' }, id, { releases: [], runs: [], treeRuns: {} })).toMatchObject({ ok: false, status: 403 });
      });
    });

    describe('what a member posts', () => {
      it('posts a message in a chat of the project as the member, whoever they are on it', async () => {
        const { hub, id, onHub } = await shared();
        const posted = valueOf(await hub.post(cy, id, 'channel-p1', { content: 'hello' }));
        expect(posted.message).toMatchObject({ role: 'user', content: 'hello', author: { kind: 'person', id: 'cy' } });
        expect(posted.asked).toBeUndefined();
        expect(((await onHub.record('conversations', 'channel-p1'))!.messages as unknown[]).length).toBe(1);
        expect((await onHub.changes(0, 10)).at(-1)).toMatchObject({ origin: 'person:cy', change: { kind: 'conversations', id: 'channel-p1' } });
      });

      it('asks Koala for a client who asks, naming the message, and waits for the owner\'s instance to start the turn', async () => {
        const { hub, id, onHub } = await shared();
        const posted = valueOf(await hub.post(cy, id, 'channel-p1', { content: 'green?', askKoala: true }));
        expect(posted.asked).toMatchObject({ kind: 'ask-koala', state: 'waiting', input: { conversationId: 'channel-p1', at: posted.message.at, content: 'green?' }, by: { personId: 'cy', role: 'client' }, after: 1 });
        expect(await onHub.requests()).toHaveLength(1);
      });

      it('asks Koala for a story\'s chat without being asked to, and for a message that names Koala', async () => {
        const { hub, id } = await shared();
        expect(valueOf(await hub.post(cy, id, 'story-l1', { content: 'status?' })).asked).toBeDefined();
        expect(valueOf(await hub.post(cy, id, 'channel-p1', { content: 'hey @koala, status?' })).asked).toBeDefined();
      });

      it('posts a collaborator\'s message but leaves Koala to answer them from their own instance', async () => {
        const { hub, id, onHub } = await shared();
        const posted = valueOf(await hub.post(bo, id, 'channel-p1', { content: '@koala what is left?' }));
        expect(posted.asked).toBeUndefined();
        expect(posted.notAsked).toMatch(/from their own instance/);
        expect(await onHub.requests()).toEqual([]);
      });

      it('refuses someone not on the project, an empty message and a chat that does not exist', async () => {
        const { hub, id } = await shared();
        expect(await hub.post(eve, id, 'channel-p1', { content: 'hi' })).toMatchObject({ ok: false, status: 404 });
        expect(await hub.post(cy, id, 'nope', { content: 'hi' })).toMatchObject({ ok: false, status: 404 });
        expect(await hub.post(cy, id, 'channel-p1', { content: '   ' })).toMatchObject({ ok: false, status: 400 });
      });
    });

    describe('what a member asks the owner\'s instance to do', () => {
      it('keeps a collaborator\'s request for the owner\'s instance, and does not make it twice', async () => {
        const { hub, id, onHub } = await shared();
        const first = valueOf(await hub.request(bo, id, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'], extra: 'ignored' }));
        expect(first).toMatchObject({ kind: 'order-stories', input: { branchId: 'b1', leafIds: ['l2', 'l1'] }, by: { personId: 'bo', role: 'collaborator' }, state: 'waiting' });
        expect(first.input).not.toHaveProperty('extra');
        expect(valueOf(await hub.request(bo, id, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'] })).id).toBe(first.id);
        expect(await onHub.requests()).toHaveLength(1);
      });

      it('refuses what the member\'s role may not do, what is not part of the project and what is not a request', async () => {
        const { hub, id } = await shared();
        expect(await hub.request(cy, id, { kind: 'order-stories', branchId: 'b1', leafIds: ['l1'] })).toMatchObject({ ok: false, status: 403 });
        expect(await hub.request(bo, id, { kind: 'order-stories', branchId: 'b1', leafIds: ['zz'] })).toMatchObject({ ok: false, status: 400 });
        expect(await hub.request(bo, id, { kind: 'shell' })).toMatchObject({ ok: false, status: 400 });
        expect(await hub.request(eve, id, { kind: 'order-stories', branchId: 'b1', leafIds: ['l1'] })).toMatchObject({ ok: false, status: 404 });
      });
    });

    describe('a push to the hub\'s repository', () => {
      it('tells the owner\'s instance its project moved, and nothing for a project the hub does not have', async () => {
        const { hub, id } = await shared();
        const owner = lineOf();
        const disconnect = valueOf(hub.connectInstance(fromAnn, owner.line));
        expect(await hub.repoMoved(id)).toBe(true);
        expect(await hub.repoMoved('nowhere')).toBe(false);
        expect(owner.changed).toEqual([id]);
        disconnect();
      });
    });

    describe('what the owner\'s instance relays for a member', () => {
      it('relays nothing when the hub has no relay', async () => {
        const { hub, id } = await shared(false);
        expect(hub.connectInstance(fromAnn, lineOf().line)).toMatchObject({ ok: false, status: 404, why: 'This hub relays nothing.' });
        expect(await hub.relay(cy, id, 'extensions', {})).toMatchObject({ ok: false, status: 409, why: 'This hub cannot reach the owner\'s instance.' });
        expect(await hub.relayed(fromAnn, 'c1')).toMatchObject({ ok: false, status: 404 });
      });

      it('takes a member\'s call to the connected instance the project is worked on, and brings its answer back to the member', async () => {
        const { hub, id } = await shared();
        const ann = lineOf();
        valueOf(hub.connectInstance(fromAnn, ann.line));
        const asked = hub.relay(cy, id, 'files.list', { dir: '' });
        const taken = await ann.first;
        expect(taken).toMatchObject({ projectId: id, op: 'files.list', as: { personId: 'cy', email: 'cy@example.com', role: 'client' } });
        expect(valueOf(await hub.relayed(fromAnn, taken!.id)).id).toBe(taken!.id);
        expect(valueOf(await hub.answerRelay(fromAnn, taken!.id, { kind: 'json', status: 200, body: [] }))).toEqual({ answered: taken!.id });
        expect(valueOf(await asked)).toEqual({ kind: 'json', status: 200, body: [] });
      });

      it('hands a project\'s calls only to the instance it is worked on, and lets only that instance answer them', async () => {
        const { hub, id } = await shared();
        const [ann, other] = [lineOf(), lineOf()];
        valueOf(hub.connectInstance({ ...fromAnn, instanceId: 'i-other' }, other.line));
        expect(await hub.relay(cy, id, 'extensions', {})).toMatchObject({ ok: false, status: 409 });
        valueOf(hub.connectInstance(fromAnn, ann.line));
        void hub.relay(cy, id, 'extensions', {});
        const taken = await ann.first;
        expect(other.calls).toEqual([]);
        expect(await hub.relayed({ ...fromAnn, instanceId: 'i-other' }, taken!.id)).toMatchObject({ ok: false, status: 403 });
        expect(await hub.answerRelay({ ...fromAnn, personId: 'eve' }, taken!.id, { kind: 'json', status: 200, body: null })).toMatchObject({ ok: false, status: 404 });
        expect(await hub.answerRelay(fromAnn, 'unknown', { kind: 'json', status: 200, body: null })).toMatchObject({ ok: false, status: 404, why: 'That call is no longer waiting.' });
      });

      it('tells the instance the project is worked on when a member posts, asks, joins, changes role or leaves, never of its own pushes', async () => {
        const { hub, id } = await shared();
        const ann = lineOf();
        valueOf(hub.connectInstance(fromAnn, ann.line));
        const tells = async (act: () => Promise<unknown>): Promise<boolean> => {
          const before = ann.changed.length;
          await act();
          return ann.changed.slice(before).length > 0 && ann.changed.slice(before).every((told) => told === id);
        };
        expect(await tells(async () => valueOf(await hub.receive(fromAnn, id, [{ kind: 'leaves', id: 'l1', patch: { set: { title: 'mine' } } }])))).toBe(false);
        expect(await tells(async () => valueOf(await hub.post(bo, id, 'channel-p1', { content: 'is it live?' })))).toBe(true);
        expect(await tells(async () => valueOf(await hub.request(bo, id, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'] })))).toBe(true);
        expect(await tells(async () => valueOf(await hub.changeRole('ann', id, 'cy', 'collaborator')))).toBe(true);
        expect(await tells(async () => valueOf(await hub.remove('bo', id, 'bo')))).toBe(true);
      });

      it('says the owner\'s instance is offline when nobody is listening', async () => {
        const { hub, id } = await shared();
        expect(await hub.relay(cy, id, 'extensions', {})).toMatchObject({ ok: false, status: 409, why: 'The owner\'s instance is offline, so this cannot be read until it is back.' });
      });

      it('turns away a client who would move files, and someone not on the project', async () => {
        const { hub, id } = await shared();
        expect(await hub.relay(cy, id, 'files.move', { from: 'a', to: 'b' })).toMatchObject({ ok: false, status: 403, why: 'only an owner or a collaborator can move or remove files' });
        expect(await hub.relay(eve, id, 'extensions', {})).toMatchObject({ ok: false, status: 404 });
      });

      it('lets a failure that is not the instance being offline through', async () => {
        const store = await make();
        const failing = mock<HubRelay>();
        failing.call.mockRejectedValue(new Error('relay broke'));
        const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) }, relay: failing });
        const id = valueOf(await hub.create(ann, { name: 'Shop' })).project.id;
        await expect(hub.relay(ann, id, 'extensions', {})).rejects.toThrow('relay broke');
      });
    });
  });
}
