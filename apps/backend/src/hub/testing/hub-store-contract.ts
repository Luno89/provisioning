import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { HubInvite, HubMember, SharedProject } from '../lib/hub.js';
import type { HubRequest, HubStatus } from '../lib/hub-board.js';
import type { HubStore } from '../lib/hub-store.js';

const newId = (): string => randomBytes(12).toString('hex');
const at = '2026-10-21T00:00:00Z';

const project = (id: string, extra: Partial<SharedProject> = {}): SharedProject => ({ id, name: 'Shop', createdAt: at, createdBy: 'ann', ...extra });
const member = (personId: string, role: HubMember['role'] = 'collaborator', extra: Partial<HubMember> = {}): HubMember => ({ personId, email: `${personId}@example.com`, role, joinedAt: at, ...extra });
const invite = (projectId: string, token: string, extra: Partial<HubInvite> = {}): HubInvite => ({ token, projectId, email: `${token}@example.com`, role: 'client', invitedBy: 'ann', createdAt: at, ...extra });
const request = (id: string, when: string, extra: Partial<HubRequest> = {}): HubRequest => ({ id, kind: 'accept-task', input: { taskId: 'k1' }, by: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, at: when, after: 0, state: 'waiting', ...extra });
const status = (extra: Partial<HubStatus> = {}): HubStatus => ({ at, releases: [{ id: 'r1' }], runs: [], treeRuns: { t1: { state: 'idle' } }, ...extra });
const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.id.localeCompare(b.id));

export function sharedProjectsContract(make: () => Promise<HubStore>): void {
  describe('shared projects and who is on them', () => {
    it('keeps a project as it was saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      const id = newId();
      expect(await store.getProject(id)).toBeUndefined();
      await store.saveProject(project(id, { group: 'acme', origin: { instanceId: 'i1', projectId: 'p1' } }));
      expect(await store.getProject(id)).toEqual(project(id, { group: 'acme', origin: { instanceId: 'i1', projectId: 'p1' } }));
      await store.saveProject(project(id, { name: 'Renamed' }));
      const replaced = await store.getProject(id);
      expect(replaced).toEqual(project(id, { name: 'Renamed' }));
      expect(replaced).not.toHaveProperty('group');
      await store.deleteProject(id);
      await store.deleteProject(id);
      expect(await store.getProject(id)).toBeUndefined();
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      const id = newId();
      await store.saveProject(project(id));
      const read = await store.getProject(id);
      read!.name = 'Changed';
      expect((await store.getProject(id))?.name).toBe('Shop');
    });

    it('lists the projects a person is on in order of id, once each, and forgets the ones they leave', async () => {
      const store = await make();
      const [b, a, c] = [newId(), newId(), newId()];
      for (const id of [b, a, c]) await store.addMembership('ann', id);
      await store.addMembership('ann', a);
      await store.addMembership('bo', a);
      expect(await store.projectsOf('ann')).toEqual([a, b, c].sort());
      await store.removeMembership('ann', a);
      await store.removeMembership('ann', a);
      expect(await store.projectsOf('ann')).toEqual([b, c].sort());
      expect(await store.projectsOf('bo')).toEqual([a]);
      expect(await store.projectsOf('nobody')).toEqual([]);
    });

    it('finds the project an invite belongs to by its token until it is forgotten', async () => {
      const store = await make();
      const id = newId();
      expect(await store.projectOfInvite('tok')).toBeUndefined();
      await store.indexInvite('tok', id);
      expect(await store.projectOfInvite('tok')).toBe(id);
      await store.indexInvite('tok', newId());
      expect(await store.projectOfInvite('tok')).not.toBe(id);
      await store.forgetInvite('tok');
      await store.forgetInvite('tok');
      expect(await store.projectOfInvite('tok')).toBeUndefined();
    });
  });

  describe('one shared project\'s own records', () => {
    it('keeps its members as saved, replaces one whole when saved again, and removes one', async () => {
      const store = (await make()).project(newId());
      expect(await store.members()).toEqual([]);
      await store.saveMember(member('ann', 'owner'));
      await store.saveMember(member('bo', 'collaborator', { invitedBy: 'ann' }));
      await store.saveMember(member('bo', 'client'));
      const members = [...await store.members()].sort((a, b) => a.personId.localeCompare(b.personId));
      expect(members).toEqual([member('ann', 'owner'), member('bo', 'client')]);
      expect(members[1]).not.toHaveProperty('invitedBy');
      await store.deleteMember('ann');
      await store.deleteMember('ann');
      expect((await store.members()).map((entry) => entry.personId)).toEqual(['bo']);
    });

    it('keeps its invites by token, and removes one', async () => {
      const store = (await make()).project(newId());
      await store.saveInvite(invite('p', 'tok-a'));
      await store.saveInvite(invite('p', 'tok-b'));
      await store.saveInvite(invite('p', 'tok-a', { role: 'collaborator' }));
      const invites = [...await store.invites()].sort((a, b) => a.token.localeCompare(b.token));
      expect(invites).toEqual([invite('p', 'tok-a', { role: 'collaborator' }), invite('p', 'tok-b')]);
      await store.deleteInvite('tok-a');
      await store.deleteInvite('tok-a');
      expect((await store.invites()).map((entry) => entry.token)).toEqual(['tok-b']);
    });

    it('keeps records of each kind apart, replaces one whole when put again, and removes one', async () => {
      const store = (await make()).project(newId());
      await store.putRecord('leaves', { id: 'x', title: 'a leaf', status: 'pending' });
      await store.putRecord('trees', { id: 'x', name: 'a tree' });
      await store.putRecord('leaves', { id: 'y', title: 'another' });
      await store.putRecord('leaves', { id: 'x', title: 'a leaf again' });
      expect(byId(await store.records('leaves'))).toEqual([{ id: 'x', title: 'a leaf again' }, { id: 'y', title: 'another' }]);
      expect(await store.records('trees')).toEqual([{ id: 'x', name: 'a tree' }]);
      expect(await store.record('leaves', 'x')).toEqual({ id: 'x', title: 'a leaf again' });
      expect(await store.record('leaves', 'none')).toBeUndefined();
      expect(await store.records('branches')).toEqual([]);
      await store.deleteRecord('leaves', 'x');
      await store.deleteRecord('leaves', 'x');
      expect(await store.record('leaves', 'x')).toBeUndefined();
      expect(await store.record('trees', 'x')).toBeDefined();
    });

    it('keeps messages inside a record exactly as put', async () => {
      const store = (await make()).project(newId());
      const doc = { id: 'c1', kind: 'channel', messages: [{ role: 'user', content: 'hi', at, author: { kind: 'person', id: 'ann' } }] };
      await store.putRecord('conversations', doc);
      expect(await store.record('conversations', 'c1')).toEqual(doc);
    });

    it('hands back a copy of a record, so changing what it read changes nothing stored', async () => {
      const store = (await make()).project(newId());
      await store.putRecord('leaves', { id: 'x', nested: { n: 1 } });
      const read = await store.record('leaves', 'x');
      (read!.nested as { n: number }).n = 2;
      expect(await store.record('leaves', 'x')).toEqual({ id: 'x', nested: { n: 1 } });
    });

    it('numbers changes from one in the order they were logged, and reads them after a point up to a limit', async () => {
      const store = (await make()).project(newId());
      const first = await store.logChange({ origin: 'instance:i1', change: { kind: 'leaves', id: 'x', patch: { set: { title: 'a' } } }, at });
      const second = await store.logChange({ origin: 'person:bo', change: { kind: 'leaves', id: 'x', deleted: true }, at });
      const third = await store.logChange({ origin: 'person:bo', change: { kind: 'trees', id: 't', patch: { unset: ['name'] } }, at });
      expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
      expect(await store.changes(0, 10)).toEqual([first, second, third]);
      expect((await store.changes(1, 10)).map((change) => change.seq)).toEqual([2, 3]);
      expect((await store.changes(0, 2)).map((change) => change.seq)).toEqual([1, 2]);
      expect(await store.changes(3, 10)).toEqual([]);
    });

    it('keeps requests oldest first, and replaces one when saved again', async () => {
      const store = (await make()).project(newId());
      await store.saveRequest(request('r2', '2026-10-21T00:00:02Z'));
      await store.saveRequest(request('r1', '2026-10-21T00:00:01Z'));
      expect((await store.requests()).map((entry) => entry.id)).toEqual(['r1', 'r2']);
      await store.saveRequest(request('r1', '2026-10-21T00:00:03Z', { state: 'refused', why: 'no', settledAt: at }));
      const [first, second] = await store.requests();
      expect([first?.id, second?.id]).toEqual(['r2', 'r1']);
      expect(second).toEqual(request('r1', '2026-10-21T00:00:03Z', { state: 'refused', why: 'no', settledAt: at }));
    });

    it('keeps the last status it was given, whole', async () => {
      const store = (await make()).project(newId());
      expect(await store.status()).toBeUndefined();
      await store.putStatus(status({ addresses: { app: 'x' } }));
      expect(await store.status()).toEqual(status({ addresses: { app: 'x' } }));
      await store.putStatus(status({ at: 'later' }));
      const replaced = await store.status();
      expect(replaced).toEqual(status({ at: 'later' }));
      expect(replaced).not.toHaveProperty('addresses');
    });

    it('keeps one project\'s records out of another\'s', async () => {
      const root = await make();
      const [one, two] = [root.project(newId()), root.project(newId())];
      await one.saveMember(member('ann', 'owner'));
      await one.putRecord('leaves', { id: 'x' });
      await one.logChange({ origin: 'person:bo', change: { kind: 'leaves', id: 'x', deleted: true }, at });
      await one.putStatus(status());
      expect([await two.members(), await two.records('leaves'), await two.changes(0, 10), await two.status()]).toEqual([[], [], [], undefined]);
    });

    it('forgets everything of a project when it is dropped, and numbers its changes afresh', async () => {
      const root = await make();
      const store = root.project(newId());
      await store.saveMember(member('ann', 'owner'));
      await store.saveInvite(invite('p', 'tok'));
      await store.putRecord('leaves', { id: 'x' });
      await store.logChange({ origin: 'person:bo', change: { kind: 'leaves', id: 'x', deleted: true }, at });
      await store.saveRequest(request('r1', at));
      await store.putStatus(status());
      await store.drop();
      expect([await store.members(), await store.invites(), await store.records('leaves'), await store.changes(0, 10), await store.requests(), await store.status()]).toEqual([[], [], [], [], [], undefined]);
      expect((await store.logChange({ origin: 'person:bo', change: { kind: 'leaves', id: 'y', deleted: true }, at })).seq).toBe(1);
    });
  });
}
