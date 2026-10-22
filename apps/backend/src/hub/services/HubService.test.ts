import { describe, expect, it, vi } from 'vitest';
import { HubService } from './HubService.js';
import { memoryHubStore } from '../lib/hub-store.js';

const ann = { id: 'ann', email: 'ann@example.com' };
const bo = { id: 'bo', email: 'bo@example.com' };
const cy = { id: 'cy', email: 'cy@example.com' };
const eve = { id: 'eve', email: 'eve@example.com' };

function setUp() {
  const store = memoryHubStore();
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
    const { hub, send, tokenOf } = setUp();
    const shop = valueOf(await hub.create(ann, { name: ' Shop ', origin: { projectId: 'p1' } }));
    expect(shop).toMatchObject({ project: { name: 'Shop', createdBy: 'ann', origin: { projectId: 'p1' } }, role: 'owner', members: [{ personId: 'ann', role: 'owner' }] });
    const id = shop.project.id;

    expect(valueOf(await hub.invite(ann, id, { email: 'Bo@Example.com', role: 'collaborator' }))).toMatchObject({ email: 'bo@example.com', role: 'collaborator', emailed: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ email: 'bo@example.com', inviterEmail: 'ann@example.com', projectName: 'Shop', role: 'collaborator' }));
    expect(valueOf(await hub.view('ann', id)).invites).toEqual([{ projectId: id, email: 'bo@example.com', role: 'collaborator', invitedBy: 'ann', createdAt: 'now' }]);

    expect(await hub.accept(eve, tokenOf(0))).toMatchObject({ ok: false, status: 403, why: 'This invite is for bo@example.com; sign in as that address to take it.' });
    expect(valueOf(await hub.invitation(bo, tokenOf(0)))).toEqual({ projectName: 'Shop', role: 'collaborator', email: 'bo@example.com', forYou: true });
    expect(valueOf(await hub.accept(bo, tokenOf(0)))).toMatchObject({ role: 'collaborator', members: [{ personId: 'ann' }, { personId: 'bo' }] });
    expect(await hub.accept(bo, tokenOf(0))).toMatchObject({ ok: false, status: 404 });
    expect((await hub.mine('bo')).map((entry) => [entry.project.name, entry.role])).toEqual([['Shop', 'collaborator']]);
  });

  it('gives each role only what it may do', async () => {
    const { hub, tokenOf } = setUp();
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
    const { hub } = setUp();
    const id = valueOf(await hub.create(ann, { name: 'Shop' })).project.id;
    for (const outcome of [await hub.view('eve', id), await hub.invite(eve, id, { email: 'x@example.com', role: 'owner' }), await hub.changeRole('eve', id, 'ann', 'client'), await hub.remove('eve', id, 'ann'), await hub.view('ann', '../admin')]) {
      expect(outcome).toEqual({ ok: false, status: 404, why: 'There is no such project, or you are not on it.' });
    }
    expect(await hub.mine('eve')).toEqual([]);
  });

  it('keeps one owner, lets people leave, and takes an invite back', async () => {
    const { hub, tokenOf } = setUp();
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
    const { hub } = setUp();
    const first = valueOf(await hub.create(ann, { name: 'Shop', origin: { instanceId: 'i1', projectId: 'p1' } }));
    expect(valueOf(await hub.create(ann, { name: 'Shop again', origin: { instanceId: 'i1', projectId: 'p1' } })).project.id).toBe(first.project.id);
    expect(valueOf(await hub.create(ann, { name: 'Other', origin: { instanceId: 'i1', projectId: 'p2' } })).project.id).not.toBe(first.project.id);
  });

  it('lets only an owner delete a project, by typing its name, and leaves nothing of it', async () => {
    const { hub, store, tokenOf } = setUp();
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
    const { hub, store, tokenOf } = setUp();
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
    const { hub, store, tokenOf } = setUp();
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
  });

  it('is shared only from an instance, with a repository on the hub, and is taken back only by that instance, which deletes everything of it', async () => {
    const repos = { create: vi.fn(async (id: string) => ({ url: `http://gitea/shared-${id}/project.git`, username: `shared-${id}-bot`, token: 't' })), remove: vi.fn(async () => undefined), files: async () => [], read: async () => null };
    const store = memoryHubStore();
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
    const hub = new HubService({ store: memoryHubStore(), invites: { send: async () => ({ link: 'l', emailed: false }) } });
    const fromAnn = { kind: 'instance' as const, personId: 'ann', instanceId: 'i-ann', email: 'ann@example.com' };
    expect(await hub.share(fromAnn, { name: 'Shop', projectId: 'p1', group: 'ac-me' })).toMatchObject({ ok: false, status: 400 });
    const shared = valueOf(await hub.share(fromAnn, { name: 'Shop', projectId: 'p1', group: 'acme' }));
    expect(shared.view.project.group).toBe('acme');
    expect(valueOf(await hub.view('ann', shared.view.project.id)).project.group).toBe('acme');
    expect((await hub.mine('ann'))[0]?.project.group).toBe('acme');
    expect(valueOf(await hub.share(fromAnn, { name: 'Other', projectId: 'p2' })).view.project.group).toBeUndefined();
  });
});
