import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { FileScope } from '../../files/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { objectWith } from '../../platform/lib/test-matchers.js';
import type { HubLink, SyncedDoc } from '../lib/hub-sync.js';
import type { HubRequest, HubRequestKind } from '../lib/hub-board.js';
import type { HubRole } from '../lib/hub.js';
import { HubInstanceWork, type HubInstanceWorkDeps, type InstanceCall, type InstanceFiles } from './HubInstanceWork.js';

const now = '2026-10-21T00:00:00Z';
const link: HubLink = { projectId: 'p1', ownerId: 'ann', hubProjectId: 'hub-1', pulledThrough: 0, sharedAt: now };
const ok = { ok: true as const };

async function world() {
  const db = memoryDatabase();
  await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: 'ann', createdAt: now } as never);
  await db.projects.saveProject({ id: 'p9', name: 'Other', ownerId: 'eve', createdAt: now } as never);
  await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
  await db.projects.saveTree({ id: 't2', ownerId: 'ann', name: 'Private', type: 'odoo' as never, projectIds: ['p2'], createdAt: now, updatedAt: now });
  await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
  await db.projects.saveBranch({ id: 'b2', ownerId: 'ann', treeId: 't2', title: 'Hidden', createdAt: now, updatedAt: now });
  await db.projects.saveLeaf({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'pending', createdAt: now, updatedAt: now });
  await db.projects.saveLeaf({ id: 'l2', ownerId: 'ann', branchId: 'b1', title: 'Refund', status: 'pending', createdAt: now, updatedAt: now });
  await db.projects.saveLeaf({ id: 'l3', ownerId: 'ann', branchId: 'b2', title: 'Secret', status: 'pending', createdAt: now, updatedAt: now });
  await db.projects.saveTask({ id: 'k1', ownerId: 'ann', leafId: 'l1', title: 'Wire it', status: 'proposed' } as never);
  await db.projects.saveTask({ id: 'k2', ownerId: 'ann', leafId: 'l3', title: 'Hide it', status: 'proposed' } as never);
  await db.projects.saveTask({ id: 'k3', ownerId: 'ann', projectId: 'p1', title: 'Loose', status: 'proposed' } as never);
  await db.projects.saveTask({ id: 'k4', ownerId: 'eve', leafId: 'l1', title: 'Not ann\'s', status: 'proposed' } as never);
  await db.engine.saveConversation({ id: 'channel-p1', ownerId: 'ann', kind: 'channel', treeId: 't1', projectId: 'p1', messages: [], createdAt: now, updatedAt: now } as never);
  await db.engine.saveConversation({ id: 'private', ownerId: 'ann', treeId: 't1', projectId: 'p1', messages: [], createdAt: now, updatedAt: now } as never);
  await db.engine.saveConversation({ id: 'other-channel', ownerId: 'eve', kind: 'channel', treeId: 't1', messages: [], createdAt: now, updatedAt: now } as never);
  await db.projects.savePlanProposal({ id: 'pp1', ownerId: 'ann', conversationId: 'channel-p1' } as never);
  await db.projects.savePlanProposal({ id: 'pp2', ownerId: 'ann', conversationId: 'private' } as never);

  const act = mock<HubInstanceWorkDeps['act']>();
  act.approvePlan.mockResolvedValue(ok);
  act.rejectPlan.mockResolvedValue(ok);
  act.orderStories.mockResolvedValue(ok);
  act.orderFeatures.mockResolvedValue(ok);
  act.decideTask.mockResolvedValue(ok);
  act.askKoala.mockResolvedValue(ok);
  act.openChat.mockResolvedValue(ok);
  const live = mock<HubInstanceWorkDeps['live']>();
  const files = mock<InstanceFiles>();
  const status = vi.fn<HubInstanceWorkDeps['status']>(async (ownerId, project, treeIds) => ({ at: 'now', releases: [], runs: [], treeRuns: Object.fromEntries(treeIds.map((id) => [id, { state: 'idle' }])), addresses: { owner: ownerId, project: project.id } }));
  const work = new HubInstanceWork({ store: db, status, act, live, files });
  return { db, act, live, files, status, work };
}

const request = (kind: HubRequestKind | 'member-removed', input: Record<string, unknown>, by: Partial<HubRequest['by']> = {}): HubRequest => ({ id: 'r1', kind, input, by: { personId: 'bo', email: 'bo@example.com', role: 'collaborator', ...by }, at: '2026-10-21T01:00:00Z', after: 0, state: 'waiting' });

const refusal = { ok: false, why: 'That is not part of the shared project on the owner\'s instance.' };

describe('what the shared project holds on the owner\'s instance', () => {
  it('holds the project\'s epics and their features, stories, tasks, chats and cards, and nobody else\'s', async () => {
    const { work } = await world();
    const scope = await work.scope(link);
    expect([...scope.treeIds]).toEqual(['t1']);
    expect([...scope.branchIds]).toEqual(['b1']);
    expect([...scope.leafIds].sort()).toEqual(['l1', 'l2']);
    expect(scope.tasks.map((task) => task.id).sort()).toEqual(['k1', 'k3']);
    expect(scope.proposals.map((proposal) => proposal.id)).toEqual(['pp1']);
    expect(scope.conversations.map((chat) => chat.id)).toEqual(['channel-p1']);
    expect(scope.branches.map((entry) => entry.id)).toEqual(['b1']);
    expect(scope.leaves.map((entry) => entry.id).sort()).toEqual(['l1', 'l2']);
  });

  it('says what is live for the project from the trees it holds', async () => {
    const { work, status } = await world();
    expect(await work.statusOf(link)).toEqual({ at: 'now', releases: [], runs: [], treeRuns: { t1: { state: 'idle' } }, addresses: { owner: 'ann', project: 'p1' } });
    expect(status).toHaveBeenCalledWith('ann', objectWith({ id: 'p1' }), ['t1']);
  });

  it('says nothing for a project its owner no longer has, or one that is someone else\'s', async () => {
    const { work, status } = await world();
    expect(await work.statusOf({ ...link, projectId: 'gone' })).toBeUndefined();
    expect(await work.statusOf({ ...link, projectId: 'p9' })).toBeUndefined();
    expect(status).not.toHaveBeenCalled();
  });
});

describe('carrying out what a member asked for', () => {
  it('approves and rejects only cards that belong to the project', async () => {
    const { work, act } = await world();
    expect(await work.carryOut(link, request('approve-plan', { proposalId: 'pp1' }))).toEqual(ok);
    expect(act.approvePlan).toHaveBeenCalledWith('ann', 'pp1');
    expect(await work.carryOut(link, request('approve-plan', { proposalId: 'pp2' }))).toEqual(refusal);
    expect(await work.carryOut(link, request('reject-plan', { proposalId: 'pp1', reason: 'not now' }))).toEqual(ok);
    expect(act.rejectPlan).toHaveBeenCalledWith('ann', 'pp1', 'not now');
    expect(await work.carryOut(link, request('reject-plan', { proposalId: 'pp1', reason: 7 }))).toEqual(ok);
    expect(act.rejectPlan).toHaveBeenLastCalledWith('ann', 'pp1', undefined);
    expect(await work.carryOut(link, request('reject-plan', { proposalId: 'nope' }))).toEqual(refusal);
    expect(await work.carryOut(link, request('approve-plan', {}))).toEqual(refusal);
  });

  it('puts a feature\'s stories in a new order only when they are all the project\'s', async () => {
    const { work, act } = await world();
    expect(await work.carryOut(link, request('order-stories', { branchId: 'b1', leafIds: ['l2', 'l1'] }))).toEqual(ok);
    expect(act.orderStories).toHaveBeenCalledWith('ann', 'b1', ['l2', 'l1']);
    expect(await work.carryOut(link, request('order-stories', { branchId: 'b1', leafIds: ['l2', 'l3'] }))).toEqual(refusal);
    expect(await work.carryOut(link, request('order-stories', { branchId: 'b2', leafIds: ['l3'] }))).toEqual(refusal);
  });

  it('puts an epic\'s features in a new order only when they are all the project\'s', async () => {
    const { work, act } = await world();
    expect(await work.carryOut(link, request('order-features', { treeId: 't1', branchIds: ['b1'] }))).toEqual(ok);
    expect(act.orderFeatures).toHaveBeenCalledWith('ann', 't1', ['b1']);
    expect(await work.carryOut(link, request('order-features', { treeId: 't1', branchIds: ['b1', 'b2'] }))).toEqual(refusal);
    expect(await work.carryOut(link, request('order-features', { treeId: 't2', branchIds: ['b2'] }))).toEqual(refusal);
  });

  it('accepts or drops only tasks that belong to the project', async () => {
    const { work, act } = await world();
    expect(await work.carryOut(link, request('accept-task', { taskId: 'k1' }))).toEqual(ok);
    expect(act.decideTask).toHaveBeenCalledWith('ann', 'k1', 'accepted');
    expect(await work.carryOut(link, request('drop-task', { taskId: 'k3' }))).toEqual(ok);
    expect(act.decideTask).toHaveBeenLastCalledWith('ann', 'k3', 'dropped');
    expect(await work.carryOut(link, request('accept-task', { taskId: 'k2' }))).toEqual(refusal);
    expect(await work.carryOut(link, request('drop-task', { taskId: 'k4' }))).toEqual(refusal);
  });

  it('opens the chat of a story or a feature of the project, and of nothing else', async () => {
    const { work, act } = await world();
    expect(await work.carryOut(link, request('open-chat', { item: 'story', id: 'l1' }))).toEqual(ok);
    expect(act.openChat).toHaveBeenCalledWith('ann', { kind: 'story', leafId: 'l1' });
    expect(await work.carryOut(link, request('open-chat', { item: 'feature', id: 'b1' }))).toEqual(ok);
    expect(act.openChat).toHaveBeenLastCalledWith('ann', { kind: 'feature', branchId: 'b1' });
    expect(await work.carryOut(link, request('open-chat', { item: 'story', id: 'l3' }))).toEqual(refusal);
    expect(await work.carryOut(link, request('open-chat', { item: 'feature', id: 'b2' }))).toEqual(refusal);
    expect(await work.carryOut(link, request('open-chat', { item: 'epic', id: 't1' }))).toEqual(refusal);
  });

  it('revokes a removed member\'s access, and never the owner\'s', async () => {
    const { work, act } = await world();
    expect(await work.carryOut(link, request('member-removed', { personId: 'cy' }))).toEqual(ok);
    expect(act.memberRemoved).toHaveBeenCalledWith({ personId: 'cy', because: 'removed-from-shared-project', at: '2026-10-21T01:00:00Z', sharedProjectId: 'hub-1' });
    expect(await work.carryOut(link, request('member-removed', { personId: 'ann' }))).toEqual({ ok: false, why: 'A removal names a member other than the owner.' });
    expect(await work.carryOut(link, request('member-removed', {}))).toMatchObject({ ok: false });
    expect(act.memberRemoved).toHaveBeenCalledTimes(1);
  });

  it('has Koala answer a note in a chat of the project, for the member who asked', async () => {
    const { work, act } = await world();
    const asking = request('ask-koala', { conversationId: 'channel-p1', at: '2026-10-21T00:30:00Z', content: 'green?' }, { personId: 'cy', email: 'cy@example.com', role: 'client' });
    expect(await work.carryOut(link, asking)).toEqual(ok);
    expect(act.askKoala).toHaveBeenCalledWith('ann', objectWith({ id: 'channel-p1' }), { at: '2026-10-21T00:30:00Z', content: 'green?' }, { personId: 'cy', email: 'cy@example.com', role: 'client', projectId: 'p1', hubProjectId: 'hub-1' });
  });

  it('has Koala answer the owner as the owner, without acting for anyone', async () => {
    const { work, act } = await world();
    const asking = request('ask-koala', { conversationId: 'channel-p1', at: 'a', content: 'hi' }, { personId: 'ann', email: 'ann@example.com', role: 'owner' });
    await work.carryOut(link, asking);
    expect(act.askKoala).toHaveBeenCalledWith('ann', objectWith({ id: 'channel-p1' }), { at: 'a', content: 'hi' }, undefined);
  });

  it('refuses a note in a chat that is not the project\'s, or that is somebody else\'s', async () => {
    const { work, act } = await world();
    expect(await work.carryOut(link, request('ask-koala', { conversationId: 'private', at: 'a', content: 'x' }))).toEqual(refusal);
    expect(await work.carryOut(link, request('ask-koala', { conversationId: 'other-channel', at: 'a', content: 'x' }))).toEqual(refusal);
    expect(act.askKoala).not.toHaveBeenCalled();
  });

  it('passes on what the instance said when it could not do what was asked', async () => {
    const { work, act } = await world();
    act.approvePlan.mockResolvedValue({ ok: false, why: 'already approved' });
    expect(await work.carryOut(link, request('approve-plan', { proposalId: 'pp1' }))).toEqual({ ok: false, why: 'already approved' });
  });
});

describe('answering what the hub relays for a member', () => {
  const call = (op: InstanceCall['op'], args: Record<string, unknown> = {}, role: HubRole = 'collaborator', upload?: InstanceCall['upload']): InstanceCall => ({ id: 'c1', op, args, as: { personId: 'bo', email: 'bo@example.com', role }, ...(upload ? { upload } : {}) });
  const json = (status: number, body: unknown) => ({ kind: 'json', status, body });

  it('refuses an operation the hub may not ask', async () => {
    const { work } = await world();
    expect(await work.handle(link, call('shell' as never))).toEqual(json(400, { error: 'shell is not something the hub may ask' }));
  });

  it('turns a client away from moving or removing files, whatever the file', async () => {
    const { work, files } = await world();
    for (const op of ['files.move', 'files.remove'] as const) {
      expect(await work.handle(link, call(op, { path: 'a', from: 'a', to: 'b' }, 'client'))).toEqual(json(403, { error: 'only an owner or a collaborator can move or remove files' }));
    }
    expect(files.move).not.toHaveBeenCalled();
    expect(files.remove).not.toHaveBeenCalled();
  });

  it('says the project is gone when its owner no longer has it', async () => {
    const { work } = await world();
    expect(await work.handle({ ...link, projectId: 'gone' }, call('extensions'))).toEqual(json(404, { error: 'The shared project is no longer on its owner\'s instance.' }));
  });

  it('gives the feed of a run of one of the project\'s trees, from where the member left off', async () => {
    const { work, live } = await world();
    live.turns.mockResolvedValue({ entries: ['x'] });
    expect(await work.handle(link, call('turns', { turnId: 'grove-run-t1~1', after: 4, under: 'run-9' }))).toEqual(json(200, { entries: ['x'] }));
    expect(live.turns).toHaveBeenCalledWith('ann', 'grove-run-t1~1', 4, 'run-9');
    await work.handle(link, call('turns', { turnId: 'grove-run-t1~1', after: -3 }));
    expect(live.turns).toHaveBeenLastCalledWith('ann', 'grove-run-t1~1', 0, undefined);
    await work.handle(link, call('turns', { turnId: 'grove-run-t1~1' }));
    expect(live.turns).toHaveBeenLastCalledWith('ann', 'grove-run-t1~1', 0, undefined);
  });

  it('turns away a run that is not one of the project\'s trees', async () => {
    const { work, live } = await world();
    for (const op of ['turns', 'procedure', 'endings'] as const) {
      expect(await work.handle(link, call(op, { turnId: 'grove-run-t2~1', id: 'x' }))).toEqual(json(404, { error: 'That run is not part of this project.' }));
      expect(await work.handle(link, call(op, { turnId: 'not-a-run' }))).toEqual(json(404, { error: 'That run is not part of this project.' }));
    }
    expect(live.turns).not.toHaveBeenCalled();
  });

  it('shows a procedure only to a member of a project that a run of its tree used', async () => {
    const { work, live } = await world();
    live.turnLog.calledWith('ann', 'grove-run-t1~1').mockResolvedValue([{ events: [{ type: 'run.started', runId: 'r1', loopId: 'grove-run' } as never] }]);
    live.procedure.calledWith('ann', 'grove-run').mockResolvedValue({ procedure: { id: 'grove-run' }, mine: false });
    expect(await work.handle(link, call('procedure', { turnId: 'grove-run-t1~1', id: 'grove-run' }))).toEqual(json(200, { procedure: { id: 'grove-run' }, mine: false }));
    expect(await work.handle(link, call('procedure', { turnId: 'grove-run-t1~1', id: 'my-private-one' }))).toEqual(json(404, { error: 'No run of this project used a procedure with that id' }));
  });

  it('says a procedure is not found when the instance no longer has it', async () => {
    const { work, live } = await world();
    live.turnLog.mockResolvedValue([{ events: [{ type: 'run.started', runId: 'r1', loopId: 'gone' } as never] }]);
    live.procedure.mockResolvedValue(undefined);
    expect(await work.handle(link, call('procedure', { turnId: 'grove-run-t1~1', id: 'gone' }))).toMatchObject({ status: 404 });
  });

  it('reports how the project\'s runs ended, and no others', async () => {
    const { work, live } = await world();
    live.endings.mockResolvedValue({ endings: [] });
    expect(await work.handle(link, call('endings', { turnId: 'grove-run-t1~1', ids: ['grove-run-t1~1', 'grove-run-t1~1-executor-1', 'grove-run-t1~10', 'grove-run-t2~1', 7] }))).toEqual(json(200, { endings: [] }));
    expect(live.endings).toHaveBeenCalledWith('ann', ['grove-run-t1~1', 'grove-run-t1~1-executor-1']);
    await work.handle(link, call('endings', { turnId: 'grove-run-t1~1' }));
    expect(live.endings).toHaveBeenLastCalledWith('ann', []);
  });

  it('lists the extensions of the owner\'s instance', async () => {
    const { work, live } = await world();
    live.extensions.mockResolvedValue([{ id: 'files' }]);
    expect(await work.handle(link, call('extensions'))).toEqual(json(200, [{ id: 'files' }]));
    expect(live.extensions).toHaveBeenCalledWith('ann');
  });
});

describe('answering a member\'s files', () => {
  const call = (op: InstanceCall['op'], args: Record<string, unknown> = {}, role: HubRole = 'collaborator', upload?: InstanceCall['upload']): InstanceCall => ({ id: 'c1', op, args, as: { personId: 'bo', email: 'bo@example.com', role }, ...(upload ? { upload } : {}) });
  const entry = (path: string) => ({ name: path.split('/').pop()!, path, type: 'file' as const });
  const refused = (status: 400 | 404 | 409, why: string) => ({ ok: false as const, status, why });
  const inProject = matches<FileScope>((scope) => scope.kind === 'project' && scope.project.id === 'p1');

  it('lists a folder, or the top of the project when none is named', async () => {
    const { work, files } = await world();
    files.list.mockResolvedValue({ ok: true, value: [entry('a/b.txt')] });
    expect(await work.handle(link, call('files.list', { dir: 'a/' }))).toEqual({ kind: 'json', status: 200, body: [entry('a/b.txt')] });
    expect(files.list).toHaveBeenCalledWith('ann', objectWith({ kind: 'project' }), 'a');
    await work.handle(link, call('files.list'));
    expect(files.list).toHaveBeenLastCalledWith('ann', objectWith({ kind: 'project' }), '');
  });

  it('refuses a folder that climbs out of the project', async () => {
    const { work, files } = await world();
    expect(await work.handle(link, call('files.list', { dir: '../etc' }))).toEqual({ kind: 'json', status: 400, body: { error: 'that is not a folder in the project' } });
    expect(files.list).not.toHaveBeenCalled();
  });

  it('passes on the files service\'s refusal as it gave it', async () => {
    const { work, files } = await world();
    files.list.mockResolvedValue(refused(409, 'no server'));
    expect(await work.handle(link, call('files.list', { dir: '' }))).toEqual({ kind: 'json', status: 409, body: { error: 'no server' } });
  });

  it('searches the project\'s files by name', async () => {
    const { work, files } = await world();
    files.search.mockResolvedValue({ ok: true, value: [entry('nda.pdf')] });
    expect(await work.handle(link, call('files.search', { q: 'nda' }))).toEqual({ kind: 'json', status: 200, body: [entry('nda.pdf')] });
    expect(files.search).toHaveBeenCalledWith('ann', objectWith({ kind: 'project' }), 'nda');
    await work.handle(link, call('files.search', { q: 5 }));
    expect(files.search).toHaveBeenLastCalledWith('ann', objectWith({ kind: 'project' }), '');
  });

  it('streams a file back with its type, name and size', async () => {
    const { work, files } = await world();
    const stream = Readable.from(['pdf']);
    files.download.mockResolvedValue({ ok: true, value: { stream, contentType: 'application/pdf', size: 3 } });
    expect(await work.handle(link, call('files.read', { path: 'contracts/nda.pdf' }))).toEqual({ kind: 'stream', status: 200, type: 'application/pdf', name: 'nda.pdf', size: 3, stream });
    expect(files.download).toHaveBeenCalledWith('ann', objectWith({ kind: 'project' }), 'contracts/nda.pdf');
  });

  it('streams a file of unknown size without one', async () => {
    const { work, files } = await world();
    files.download.mockResolvedValue({ ok: true, value: { stream: Readable.from([]), contentType: 'text/plain' } });
    expect(await work.handle(link, call('files.read', { path: 'a.txt' }))).not.toHaveProperty('size');
  });

  it('says a file is missing, or that a name is not a file', async () => {
    const { work, files } = await world();
    files.download.mockResolvedValue(refused(404, 'There is no such file.'));
    expect(await work.handle(link, call('files.read', { path: 'gone.txt' }))).toEqual({ kind: 'json', status: 404, body: { error: 'There is no such file.' } });
    expect(await work.handle(link, call('files.read', { path: '' }))).toEqual({ kind: 'json', status: 400, body: { error: 'that is not a file in the project' } });
  });

  it('stores an upload where it was told, with its type and size', async () => {
    const { work, files } = await world();
    const body = Readable.from(['new']);
    files.upload.mockResolvedValue({ ok: true, value: { path: 'a.txt' } });
    const upload = { type: 'text/plain', size: 3, open: async () => body };
    expect(await work.handle(link, call('files.upload', { path: 'a.txt' }, 'collaborator', upload))).toEqual({ kind: 'json', status: 200, body: { path: 'a.txt' } });
    expect(files.upload).toHaveBeenCalledWith('ann', objectWith({ kind: 'project' }), 'a.txt', body, 3, 'text/plain');
  });

  it('refuses an upload that names no place or carries no file', async () => {
    const { work, files } = await world();
    const upload = { type: 'text/plain', open: async () => Readable.from([]) };
    expect(await work.handle(link, call('files.upload', { path: '' }, 'collaborator', upload))).toMatchObject({ status: 400 });
    expect(await work.handle(link, call('files.upload', { path: 'a.txt' }))).toMatchObject({ status: 400 });
    expect(files.upload).not.toHaveBeenCalled();
  });

  it('lets a client add a file but not replace one that has the name', async () => {
    const { work, files } = await world();
    const upload = () => ({ type: 'text/plain', size: 3, open: async () => Readable.from(['new']) });
    files.list.calledWith('ann', inProject, 'contracts').mockResolvedValue({ ok: true, value: [entry('contracts/nda.pdf')] });
    files.upload.mockResolvedValue({ ok: true, value: { path: 'x' } });
    expect(await work.handle(link, call('files.upload', { path: 'contracts/nda.pdf' }, 'client', upload()))).toMatchObject({ kind: 'json', status: 409 });
    expect(files.upload).not.toHaveBeenCalled();
    expect(await work.handle(link, call('files.upload', { path: 'contracts/brief.pdf' }, 'client', upload()))).toMatchObject({ status: 200 });
    expect(await work.handle(link, call('files.upload', { path: 'contracts/nda.pdf' }, 'collaborator', upload()))).toMatchObject({ status: 200 });
  });

  it('looks for a clashing name at the top of the project when the file goes there, and finds none when the folder cannot be listed', async () => {
    const { work, files } = await world();
    const upload = () => ({ type: 'text/plain', open: async () => Readable.from(['new']) });
    files.list.mockResolvedValueOnce({ ok: true, value: [entry('top.txt')] }).mockResolvedValueOnce(refused(404, 'no folder'));
    files.upload.mockResolvedValue({ ok: true, value: { path: 'x' } });
    expect(await work.handle(link, call('files.upload', { path: 'top.txt' }, 'client', upload()))).toMatchObject({ status: 409 });
    expect(files.list).toHaveBeenCalledWith('ann', objectWith({ kind: 'project' }), '');
    expect(await work.handle(link, call('files.upload', { path: 'new/top.txt' }, 'client', upload()))).toMatchObject({ status: 200 });
  });

  it('makes a folder, and refuses a name that is not one', async () => {
    const { work, files } = await world();
    files.makeFolder.mockResolvedValue({ ok: true, value: { path: 'from-cy' } });
    expect(await work.handle(link, call('files.folder', { path: 'from-cy' }, 'client'))).toEqual({ kind: 'json', status: 200, body: { path: 'from-cy' } });
    expect(files.makeFolder).toHaveBeenCalledWith('ann', objectWith({ kind: 'project' }), 'from-cy');
    expect(await work.handle(link, call('files.folder', { path: 'a/../..' }))).toEqual({ kind: 'json', status: 400, body: { error: 'that is not a folder name' } });
  });

  it('moves a file for a collaborator, and refuses a move that names nothing', async () => {
    const { work, files } = await world();
    files.move.mockResolvedValue({ ok: true, value: { path: 'nda.pdf' } });
    expect(await work.handle(link, call('files.move', { from: 'contracts/nda.pdf', to: 'nda.pdf' }))).toEqual({ kind: 'json', status: 200, body: { path: 'nda.pdf' } });
    expect(files.move).toHaveBeenCalledWith('ann', objectWith({ kind: 'project' }), 'contracts/nda.pdf', 'nda.pdf');
    expect(await work.handle(link, call('files.move', { from: 'a' }))).toEqual({ kind: 'json', status: 400, body: { error: 'say what moves and where to' } });
  });

  it('removes a file for a collaborator, and refuses a removal that names nothing', async () => {
    const { work, files } = await world();
    files.remove.mockResolvedValue({ ok: true, value: { path: 'a.txt' } });
    expect(await work.handle(link, call('files.remove', { path: 'a.txt' }))).toEqual({ kind: 'json', status: 200, body: { path: 'a.txt' } });
    expect(files.remove).toHaveBeenCalledWith('ann', objectWith({ kind: 'project' }), 'a.txt');
    expect(await work.handle(link, call('files.remove', {}))).toEqual({ kind: 'json', status: 400, body: { error: 'that is not a file in the project' } });
  });
});

describe('whose records make up the project', () => {
  it('holds nothing of a project for someone who owns none of its records', async () => {
    const { work } = await world();
    const scope = await work.scope({ ...link, ownerId: 'eve', projectId: 'p1' });
    expect([...scope.treeIds]).toEqual([]);
    expect(scope.tasks.map((task: SyncedDoc) => task.id)).toEqual([]);
  });
});
