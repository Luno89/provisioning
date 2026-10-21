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
});
