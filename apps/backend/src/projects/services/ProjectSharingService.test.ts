import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { containing, matching } from '../../platform/lib/test-matchers.js';
import { decryptValue } from '../../platform/lib/crypto.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { sharedProjectRecordsBehaviour } from '../testing/project-sharing-behaviour.js';
import { ProjectSharingService, type HubSharing, type ProjectGroups } from './ProjectSharingService.js';

const now = '2026-10-21T00:00:00Z';
const ann = { id: 'ann', email: 'ann@example.com' };
const dataKey = 'k'.repeat(32) as never;

interface Options { domain?: string; groups?: Partial<ProjectGroups>; reachable?: boolean }

async function setUp(given: Options = {}) {
  const db = memoryDatabase();
  const sharing = mock<HubSharing>();
  sharing.reachable.mockResolvedValue(given.reachable ?? true);
  sharing.share.mockImplementation(async (_owner, project) => ({ hubProjectId: `hub-${project.id}` }));
  const groups = mock<ProjectGroups>();
  groups.check.mockResolvedValue(null);
  groups.claim.mockResolvedValue(undefined);
  groups.release.mockResolvedValue(undefined);
  Object.assign(groups, given.groups);
  const sync = { once: vi.fn(async () => undefined) };
  const republish = vi.fn(async () => undefined);
  const notices: unknown[] = [];
  const service = new ProjectSharingService({
    store: db, sharing, sync, dataKey, groups, republish, now: () => now,
    ownerRepo: async (project) => ({ url: `http://gitea/${project.giteaOwner}/${project.giteaRepo}.git` }),
    notify: async (_owner, scope, notice) => { notices.push([scope, notice]); },
    ...(given.domain ? { domain: given.domain } : {}),
  });
  await db.projects.saveProject({ id: 'p1', ownerId: 'ann', name: 'Shop', giteaOwner: 'koala-ann', giteaRepo: 'shop', createdAt: now } as never);
  await db.projects.saveProject({ id: 'p2', ownerId: 'ann', name: 'Mine', createdAt: now } as never);
  await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
  await db.projects.saveTree({ id: 't2', ownerId: 'ann', name: 'Mine', type: 'odoo' as never, projectIds: ['p2'], createdAt: now, updatedAt: now });
  await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: now, updatedAt: now });
  await db.projects.saveLeaf({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'pending', createdAt: now, updatedAt: now });
  await db.projects.saveTask({ id: 'k1', ownerId: 'ann', leafId: 'l1', title: 'T', doneMeans: 'd', dependsOn: [], status: 'accepted', runs: [], createdAt: now, updatedAt: now });
  await db.engine.saveConversation({ id: 'channel-p1', ownerId: 'ann', kind: 'channel', treeId: 't1', projectId: 'p1', messages: [{ role: 'user', content: 'earlier talk', at: now }], createdAt: now, updatedAt: now } as never);
  await db.engine.saveConversation({ id: 'mine', ownerId: 'ann', treeId: 't2', projectId: 'p2', messages: [], createdAt: now, updatedAt: now } as never);
  return { db, sharing, groups, sync, republish, notices, service };
}

describe('previewing what sharing a project moves', () => {
  it('counts what would move and lists what stays, naming the repository, and says whether a hub is there', async () => {
    const { service } = await setUp();
    const preview = await service.preview('ann', 'p1');
    expect(preview).toEqual({
      ok: true,
      value: {
        canShare: true, addresses: { scope: 'owner' },
        moves: { epics: 1, features: 1, stories: 1, tasks: 1, chats: 1, repository: 'shop' },
        stays: ['your other chats with Koala', 'the project\'s secrets', 'its builds and releases, which still run on your instance', 'the deployed app and its clusters'],
      },
    });
  });

  it('says sharing is not possible where there is no hub', async () => {
    const { service } = await setUp({ reachable: false });
    expect(await service.preview('ann', 'p1')).toMatchObject({ ok: true, value: { canShare: false } });
  });

  it('counts only the owner\'s own records of the project', async () => {
    const { db, service } = await setUp();
    await db.projects.saveLeaf({ id: 'l-other', ownerId: 'bo', branchId: 'b1', title: 'x', status: 'pending', createdAt: now, updatedAt: now });
    expect(await service.preview('ann', 'p1')).toMatchObject({ value: { moves: { stories: 1 } } });
  });

  it('answers 404 for a project that is another owner\'s or not there', async () => {
    const { service } = await setUp();
    expect(await service.preview('bo', 'p1')).toEqual({ ok: false, status: 404, why: 'There is no such project.' });
    expect(await service.preview('ann', 'nope')).toMatchObject({ ok: false, status: 404 });
  });

  it('shows a shared project\'s hub id, when it was shared, and its group', async () => {
    const { db, service } = await setUp();
    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: 'hub-1', pulledThrough: 0, sharedAt: now, group: 'acme' });
    expect(await service.preview('ann', 'p1')).toMatchObject({ ok: true, value: { canShare: true, shared: { hubProjectId: 'hub-1', sharedAt: now }, group: 'acme', addresses: { scope: 'group' } } });
  });

  it('says what its apps are addressed once the instance has a domain: a placeholder before any app, then the app\'s own address', async () => {
    const { db, service } = await setUp({ domain: 'koala.dev' });
    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: 'hub-1', pulledThrough: 0, sharedAt: now, group: 'acme' });
    expect(await service.preview('ann', 'p1')).toMatchObject({ value: { addresses: { scope: 'group', example: '<app>-acme.koala.dev' } } });
    await db.infrastructure.saveDeployment({ id: 'd1', name: 'Shop Front', gitappProjectId: 'p1', clusterId: 'c1', appType: 'gitapp', status: 'running', createdAt: now } as never);
    expect(await service.preview('ann', 'p1')).toMatchObject({ value: { addresses: { example: 'shop-front-acme.koala.dev' } } });
    await db.infrastructure.saveDeployment({ id: 'd1', name: 'Shop Front', gitappProjectId: 'p1', clusterId: 'c1', appType: 'gitapp', status: 'running', publicHostname: 'front-acme.koala.dev', createdAt: now } as never);
    expect(await service.preview('ann', 'p1')).toMatchObject({ value: { addresses: { example: 'front-acme.koala.dev' } } });
  });
});

describe('the group a shared project is addressed under', () => {
  it('suggests one from the project\'s name when none is typed', async () => {
    const { groups, service } = await setUp({ domain: 'koala.dev' });
    expect(await service.groupCheck('ann', 'p1', undefined)).toEqual({ ok: true, value: { ok: false, suggested: 'shop' } });
    expect(await service.groupCheck('ann', 'p1', '')).toEqual({ ok: true, value: { ok: false, suggested: 'shop' } });
    expect(groups.check).not.toHaveBeenCalled();
  });

  it('refuses a name that breaks the rules, without asking where the instance is routed', async () => {
    const { groups, service } = await setUp();
    expect(await service.groupCheck('ann', 'p1', 'ac-me')).toMatchObject({ ok: true, value: { ok: false, problem: matching(/no dashes/), suggested: 'shop' } });
    expect(await service.groupCheck('ann', 'p1', 'mail')).toMatchObject({ value: { ok: false, problem: matching(/kept for the platform/) } });
    expect(groups.check).not.toHaveBeenCalled();
  });

  it('refuses a name another project of the owner holds, and accepts one this project holds without asking again', async () => {
    const { db, groups, service } = await setUp();
    await db.hub.saveHubLink({ projectId: 'p2', ownerId: 'ann', hubProjectId: 'hub-2', pulledThrough: 0, sharedAt: now, group: 'acme' });
    await db.hub.saveHubLink({ projectId: 'p1', ownerId: 'ann', hubProjectId: 'hub-1', pulledThrough: 0, sharedAt: now, group: 'globex' });
    expect(await service.groupCheck('ann', 'p1', 'acme')).toEqual({ ok: true, value: { ok: false, problem: '"acme" is taken', suggested: 'shop' } });
    expect(await service.groupCheck('ann', 'p1', 'globex')).toEqual({ ok: true, value: { ok: true, suggested: 'shop' } });
    expect(groups.check).not.toHaveBeenCalled();
  });

  it('asks where the instance is routed and passes its refusal on', async () => {
    const { groups, service } = await setUp({ domain: 'koala.dev' });
    groups.check.mockImplementation(async (name) => (name === 'globex' ? '"globex" is taken by an instance' : null));
    expect(await service.groupCheck('ann', 'p1', 'globex')).toEqual({ ok: true, value: { ok: false, problem: '"globex" is taken by an instance', suggested: 'shop' } });
    expect(await service.groupCheck('ann', 'p1', 'acme')).toEqual({ ok: true, value: { ok: true, suggested: 'shop', example: '<app>-acme.koala.dev' } });
  });

  it('answers 404 for a project that is not the caller\'s', async () => {
    const { service } = await setUp();
    expect(await service.groupCheck('bo', 'p1', 'acme')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('sharing a project', () => {
  it('claims the group, shares with the hub, keeps the link with the repository\'s token sealed, marks the records synced, republishes and syncs', async () => {
    const { db, sharing, groups, sync, republish, service } = await setUp();
    sharing.share.mockResolvedValue({ hubProjectId: 'hub-1', repo: { url: 'http://hub/shared-1/project.git', username: 'bot', token: 'tok-secret' } });
    const shared = await service.share(ann, 'p1', 'acme');
    expect(shared).toMatchObject({ ok: true, value: { shared: { hubProjectId: 'hub-1', sharedAt: now }, group: 'acme', addresses: { scope: 'group' } } });
    expect(groups.claim).toHaveBeenCalledWith('p1', 'acme');
    expect(sharing.share).toHaveBeenCalledWith(ann, { id: 'p1', name: 'Shop', group: 'acme' });
    const link = (await db.hub.getHubLinks())[0]!;
    expect(link).toMatchObject({ projectId: 'p1', ownerId: 'ann', hubProjectId: 'hub-1', pulledThrough: 0, sharedAt: now, group: 'acme', repo: { url: 'http://hub/shared-1/project.git', username: 'bot' } });
    expect(link.repo?.tokenEnc).not.toContain('tok-secret');
    expect(decryptValue(link.repo!.tokenEnc, dataKey)).toBe('tok-secret');
    expect((await db.hub.hubDirty(100)).map((entry) => `${entry.kind}:${entry.id}`).sort()).toEqual(['branches:b1', 'conversations:channel-p1', 'leaves:l1', 'tasks:k1', 'trees:t1']);
    expect(republish).toHaveBeenCalledTimes(1);
    expect(sync.once).toHaveBeenCalledTimes(1);
  });

  it('keeps no repository on the link when the project has none or the hub made none', async () => {
    const { db, sharing, service } = await setUp();
    await service.share(ann, 'p1', 'acme');
    expect((await db.hub.getHubLinks())[0]?.repo).toBeUndefined();
    sharing.share.mockResolvedValue({ hubProjectId: 'hub-2', repo: { url: 'u', username: 'bot', token: 't' } });
    await service.share(ann, 'p2', 'globex');
    expect((await db.hub.getHubLinks()).find((link) => link.projectId === 'p2')?.repo).toBeUndefined();
  });

  it('only syncs again when the project is already shared, sharing nothing twice', async () => {
    const { sharing, groups, sync, republish, service } = await setUp();
    await service.share(ann, 'p1', 'acme');
    expect(await service.share(ann, 'p1', 'acme')).toMatchObject({ ok: true, value: { group: 'acme' } });
    expect(sharing.share).toHaveBeenCalledTimes(1);
    expect(groups.claim).toHaveBeenCalledTimes(1);
    expect(republish).toHaveBeenCalledTimes(1);
    expect(sync.once).toHaveBeenCalledTimes(2);
  });

  it('needs a group that follows the name rules and is not taken', async () => {
    const { db, sharing, republish, service } = await setUp();
    expect(await service.share(ann, 'p1', undefined)).toMatchObject({ ok: false, status: 400, why: matching(/Name the group/) });
    expect(await service.share(ann, 'p1', 'ac-me')).toMatchObject({ ok: false, status: 400, why: matching(/no dashes/) });
    expect(await service.share(ann, 'p1', 'mail')).toMatchObject({ ok: false, status: 400, why: matching(/kept for the platform/) });
    await db.hub.saveHubLink({ projectId: 'p2', ownerId: 'ann', hubProjectId: 'hub-2', pulledThrough: 0, sharedAt: now, group: 'acme' });
    expect(await service.share(ann, 'p1', 'acme')).toEqual({ ok: false, status: 409, why: '"acme" is taken' });
    expect(sharing.share).not.toHaveBeenCalled();
    expect(republish).not.toHaveBeenCalled();
  });

  it('is refused where there is no hub, and for a project that is not the caller\'s', async () => {
    const { groups, service } = await setUp({ reachable: false });
    expect(await service.share(ann, 'p1', 'acme')).toEqual({ ok: false, status: 409, why: 'Sharing needs a hub, and this Koala has none.' });
    expect(groups.claim).not.toHaveBeenCalled();
    expect(await service.share({ id: 'bo', email: 'bo@example.com' }, 'p1', 'acme')).toMatchObject({ ok: false, status: 404 });
  });

  it('answers 409 with the reason when the group cannot be claimed, and shares nothing', async () => {
    const { groups, sharing, service } = await setUp();
    groups.claim.mockRejectedValue(new Error('"globex" is taken'));
    expect(await service.share(ann, 'p1', 'globex')).toEqual({ ok: false, status: 409, why: '"globex" is taken' });
    expect(sharing.share).not.toHaveBeenCalled();
  });

  it('lets the group go and rethrows when the hub refuses, recording no link', async () => {
    const { db, groups, sharing, service } = await setUp();
    sharing.share.mockRejectedValue(new Error('the hub is down'));
    await expect(service.share(ann, 'p1', 'acme')).rejects.toThrow('the hub is down');
    expect(groups.release).toHaveBeenCalledWith('p1');
    expect(await db.hub.getHubLinks()).toEqual([]);
  });

  it('still rethrows the hub\'s failure when letting the group go fails too, saying the group stays claimed', async () => {
    const { groups, sharing, service } = await setUp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sharing.share.mockRejectedValue(new Error('the hub is down'));
    groups.release.mockRejectedValue(new Error('root is down'));
    await expect(service.share(ann, 'p1', 'acme')).rejects.toThrow('the hub is down');
    expect(warn).toHaveBeenCalledWith(containing('the group acme stays claimed for p1'));
    warn.mockRestore();
  });
});

describe('taking a project back', () => {
  async function sharedSetUp() {
    const made = await setUp();
    await made.service.share(ann, 'p1', 'acme');
    made.sync.once.mockClear();
    made.republish.mockClear();
    return made;
  }

  it('needs the project\'s name typed', async () => {
    const { db, sharing, service } = await sharedSetUp();
    expect(await service.takeBack('ann', 'p1', 'shop')).toEqual({ ok: false, status: 400, why: 'Type the project\'s name, Shop, to take it back.' });
    expect(await service.takeBack('ann', 'p1', undefined)).toMatchObject({ ok: false, status: 400 });
    expect(sharing.unshare).not.toHaveBeenCalled();
    expect(await db.hub.getHubLinks()).toHaveLength(1);
  });

  it('syncs one last time, deletes the hub\'s copy, forgets the link and what was agreed, lets the group go and republishes', async () => {
    const { db, sharing, groups, sync, republish, service } = await sharedSetUp();
    const back = await service.takeBack('ann', 'p1', ' Shop ');
    expect(back).toMatchObject({ ok: true, value: { moves: { stories: 1 } } });
    expect(back.ok && back.value.shared).toBeUndefined();
    expect(sync.once).toHaveBeenCalledTimes(1);
    expect(sharing.unshare).toHaveBeenCalledWith('ann', 'hub-p1');
    expect(groups.release).toHaveBeenCalledWith('p1');
    expect(republish).toHaveBeenCalledTimes(1);
    expect(await db.hub.getHubLinks()).toEqual([]);
    expect(await db.hub.hubSnapshot('leaves', 'l1')).toBeUndefined();
    expect((await db.projects.getLeaves())[0]?.id).toBe('l1');
  });

  it('says a project that is not shared is not shared, and 404s one that is not the caller\'s', async () => {
    const { service } = await sharedSetUp();
    expect(await service.takeBack('ann', 'p2', 'Mine')).toEqual({ ok: false, status: 409, why: 'Mine is not shared.' });
    expect(await service.takeBack('bo', 'p1', 'Shop')).toMatchObject({ ok: false, status: 404 });
  });

  it('is taken back for a deletion without a name, only the owner\'s own link', async () => {
    const { db, sharing, service } = await sharedSetUp();
    await service.takeBackForDeletion('bo', 'p1');
    expect(sharing.unshare).not.toHaveBeenCalled();
    await service.takeBackForDeletion('ann', 'p2');
    expect(sharing.unshare).not.toHaveBeenCalled();
    await service.takeBackForDeletion('ann', 'p1');
    expect(sharing.unshare).toHaveBeenCalledWith('ann', 'hub-p1');
    expect(await db.hub.getHubLinks()).toEqual([]);
  });
});

sharedProjectRecordsBehaviour(async () => memoryDatabase());
