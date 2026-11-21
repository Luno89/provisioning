import { describe, expect, it } from 'vitest';
import type { PartialInfo, ProjectMetadata } from '../../platform/index.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import type { PlanProposal } from '../lib/plan-proposals.js';
import type { SecretRequest } from '../lib/secret-requests.js';
import type { Task } from '../lib/tasks.js';
import type { Tree } from '../lib/trees.js';
import type { TreeTypeSpec } from '../lib/tree-types.js';
import type { ProjectsStore } from '../store.js';
import { NO_TX } from '../../platform/lib/transaction.js';

const at = (minute: number): string => `2026-10-10T00:${String(minute).padStart(2, '0')}:00.000Z`;

const project = (id: string, extra: Partial<ProjectMetadata> = {}): ProjectMetadata => ({
  id,
  name: id,
  ownerId: 'owner-1',
  giteaOwner: `org-${id}`,
  giteaRepo: `repo-${id}`,
  appType: 'gitapp',
  createdAt: at(0),
  ...extra,
});

const tree = (id: string, extra: Partial<Tree> = {}): Tree => ({ id, ownerId: 'owner-1', name: id, type: 'odoo', createdAt: at(0), updatedAt: at(0), ...extra });

const branch = (id: string, extra: Partial<Branch> = {}): Branch => ({ id, ownerId: 'owner-1', treeId: 'tree-1', title: id, createdAt: at(0), updatedAt: at(0), ...extra });

const leaf = (id: string, extra: Partial<Leaf> = {}): Leaf => ({ id, ownerId: 'owner-1', branchId: 'branch-1', title: id, status: 'pending', createdAt: at(0), updatedAt: at(0), ...extra });

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  ownerId: 'owner-1',
  title: id,
  doneMeans: 'it is done',
  dependsOn: [],
  status: 'proposed',
  runs: [],
  createdAt: at(0),
  updatedAt: at(0),
  ...extra,
});

const proposal = (id: string, extra: Partial<PlanProposal> = {}): PlanProposal => ({ id, ownerId: 'owner-1', status: 'proposed', createdAt: at(0), updatedAt: at(0), ...extra });

const request = (id: string, extra: Partial<SecretRequest> = {}): SecretRequest => ({
  id,
  ownerId: 'owner-1',
  projectId: 'project-1',
  key: 'DATABASE_URL',
  description: 'where the database is',
  secretReference: `secret://project-1/${id}`,
  status: 'requested',
  createdAt: at(0),
  updatedAt: at(0),
  ...extra,
});

const treeType = (id: string, extra: Partial<TreeTypeSpec> = {}): TreeTypeSpec => ({
  id,
  ownerId: 'owner-1',
  label: id,
  summary: `${id} summary`,
  language: 'node' as TreeTypeSpec['language'],
  produces: 'service',
  doneMeans: 'it runs',
  files: [{ path: 'README.md', content: '# hello' }],
  ...extra,
});

const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id).sort();

export function projectsStoreContract(make: () => Promise<ProjectsStore>): void {
  describe('projects', () => {
    it('keeps a project as it was saved, replaces it whole when saved again, and lists them all', async () => {
      const store = await make();
      expect(await store.getProjects()).toEqual([]);
      await store.saveProject(project('a', { needs: [{ service: 'db', as: 'DB' }] }));
      await store.saveProject(project('b', { ownerId: 'owner-2' }));
      expect(ids(await store.getProjects())).toEqual(['a', 'b']);
      expect((await store.getProjects()).find((stored) => stored.id === 'a')).toEqual(project('a', { needs: [{ service: 'db', as: 'DB' }] }));
      await store.saveProject({ id: 'a', name: 'renamed', appType: 'odoo-project', createdAt: at(1) });
      const replaced = (await store.getProjects()).find((stored) => stored.id === 'a');
      expect(replaced).toEqual({ id: 'a', name: 'renamed', appType: 'odoo-project', createdAt: at(1) });
      expect(replaced).not.toHaveProperty('giteaOwner');
      expect(await store.getProjects()).toHaveLength(2);
    });

    it('marks a project deleting once, keeps the mark whatever is saved over the project after, and says whether it was the one that marked it', async () => {
      const store = await make();
      await store.saveProject(project('a'));
      expect(await store.deletion('a')).toBeUndefined();
      expect(await store.markDeleting('a', { startedAt: at(1), requestedBy: 'owner-1', mode: 'permanent' })).toBe(true);
      expect(await store.markDeleting('a', { startedAt: at(2), requestedBy: 'owner-2', mode: 'archive' })).toBe(false);
      await store.saveProject(project('a', { name: 'saved over' }));
      await store.saveProjectInfo({ id: 'a', removal: undefined });
      expect(await store.deletion('a')).toEqual({ startedAt: at(1), requestedBy: 'owner-1', mode: 'permanent', phase: 'deleting' });
      expect((await store.getProjects()).find((stored) => stored.id === 'a')).toMatchObject({ name: 'saved over', removal: { startedAt: at(1) } });
      expect(await store.markDeleting('missing', { startedAt: at(1), requestedBy: 'owner-1', mode: 'permanent' })).toBe(false);
      expect(await store.deletion('missing')).toBeUndefined();
    });

    it('keeps a project archived once its deletion is done, gives it back only while archived, and lists what an owner has archived', async () => {
      const store = await make();
      await store.saveProject(project('a'));
      await store.saveProject(project('b', { giteaRepo: 'b-repo' }));
      expect(await store.archive('a')).toBe(false);
      await store.markDeleting('a', { startedAt: at(1), requestedBy: 'owner-1', mode: 'archive' });
      await store.markDeleting('b', { startedAt: at(1), requestedBy: 'owner-1', mode: 'archive' });
      expect(await store.deletion('a')).toEqual({ startedAt: at(1), requestedBy: 'owner-1', mode: 'archive', phase: 'deleting' });
      expect(await store.restore('a', 'a again')).toBe(false);
      expect(await store.archive('a')).toBe(true);
      expect((await store.deletedProjects('owner-1')).map((entry) => entry.id)).toEqual(['a']);
      expect(await store.restore('a', 'a again')).toBe(true);
      expect(await store.deletion('a')).toBeUndefined();
      expect((await store.getProjects()).find((stored) => stored.id === 'a')).toMatchObject({ name: 'a again' });
      expect(await store.deletedProjects('owner-1')).toEqual([]);
    });

    it('holds a project open for an upload being kept, and not once it is being deleted or is not there', async () => {
      const store = await make();
      await store.saveProject(project('a'));
      expect(await store.holdOpenIn(NO_TX, 'a')).toBe(true);
      await store.markDeleting('a', { startedAt: at(1), requestedBy: 'owner-1', mode: 'archive' });
      expect(await store.holdOpenIn(NO_TX, 'a')).toBe(false);
      expect(await store.holdOpenIn(NO_TX, 'missing')).toBe(false);
    });

    it('writes no deletion mark through saving a project', async () => {
      const store = await make();
      await store.saveProject(project('a', { removal: { startedAt: at(1), requestedBy: 'owner-1', mode: 'permanent', phase: 'deleting' } }));
      expect(await store.deletion('a')).toBeUndefined();
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveProject(project('a', { needs: [{ service: 'db' }] }));
      const [read] = await store.getProjects();
      read!.name = 'changed';
      read!.needs!.push({ service: 'cache' });
      expect(await store.getProjects()).toEqual([project('a', { needs: [{ service: 'db' }] })]);
    });

    it('leaves out a field saved as undefined', async () => {
      const store = await make();
      await store.saveProject(project('a', { release: undefined }));
      expect((await store.getProjects())[0]).not.toHaveProperty('release');
    });

    it('refuses a second project in the same repository, and lets a project be saved again', async () => {
      const store = await make();
      await store.saveProject(project('a', { giteaOwner: 'org', giteaRepo: 'repo' }));
      await expect(store.saveProject(project('b', { giteaOwner: 'org', giteaRepo: 'repo' }))).rejects.toThrow();
      await store.saveProject(project('a', { giteaOwner: 'org', giteaRepo: 'repo', name: 'again' }));
      await store.saveProject(project('c', { giteaOwner: 'org', giteaRepo: 'other' }));
      expect(ids(await store.getProjects())).toEqual(['a', 'c']);
    });

    it('lets any number of projects have no repository yet', async () => {
      const store = await make();
      await store.saveProject(project('a', { giteaOwner: '', giteaRepo: '' }));
      await store.saveProject(project('b', { giteaOwner: '', giteaRepo: '' }));
      await store.saveProject({ id: 'c', name: 'c', appType: 'gitapp', createdAt: at(0) });
      await store.saveProject({ id: 'd', name: 'd', appType: 'gitapp', createdAt: at(0) });
      expect(ids(await store.getProjects())).toEqual(['a', 'b', 'c', 'd']);
    });

    it('makes a project from partial information, filling what is missing', async () => {
      const store = await make();
      const made = await store.saveProjectInfo({ name: 'fresh' });
      expect(made.id).toMatch(/\S/);
      expect(made).toMatchObject({ name: 'fresh', giteaOwner: '', giteaRepo: '', appType: 'gitapp' });
      expect(Number.isNaN(Date.parse(made.createdAt))).toBe(false);
      expect(await store.getProjects()).toEqual([made]);
      const other = await store.saveProjectInfo({ name: 'fresh' });
      expect(other.id).not.toBe(made.id);
      expect(await store.getProjects()).toHaveLength(2);
    });

    it('merges partial information over the project it names, ignoring fields given as undefined', async () => {
      const store = await make();
      await store.saveProject(project('a', { language: 'node' }));
      const patch: PartialInfo<ProjectMetadata> = { id: 'a', name: 'renamed', language: undefined, deployEnv: 'staging' };
      const merged = await store.saveProjectInfo(patch);
      expect(merged).toEqual(project('a', { name: 'renamed', language: 'node', deployEnv: 'staging' }));
      expect(await store.getProjects()).toEqual([merged]);
    });

    it('fills in an empty name, repository and type of a project it merges', async () => {
      const store = await make();
      const made = await store.saveProjectInfo({ id: 'fixed', name: '', giteaOwner: '', appType: '' });
      expect(made).toMatchObject({ id: 'fixed', name: '', giteaOwner: '', giteaRepo: '', appType: 'gitapp' });
    });

    it('makes a project with the id it was given when there is none yet', async () => {
      const store = await make();
      const made = await store.saveProjectInfo({ id: 'chosen', name: 'chosen', createdAt: at(5) });
      expect(made).toEqual({ id: 'chosen', name: 'chosen', giteaOwner: '', giteaRepo: '', appType: 'gitapp', createdAt: at(5) });
    });

    it('refuses to give a project a repository another already has', async () => {
      const store = await make();
      await store.saveProject(project('a', { giteaOwner: 'org', giteaRepo: 'repo' }));
      await expect(store.saveProjectInfo({ name: 'b', giteaOwner: 'org', giteaRepo: 'repo' })).rejects.toThrow();
      expect(ids(await store.getProjects())).toEqual(['a']);
    });

    it('forgets the client files of every project that has them, and counts them', async () => {
      const store = await make();
      await store.saveProject(project('a', { clientFiles: { path: 'x' } }));
      await store.saveProject(project('b'));
      await store.saveProject(project('c', { clientFiles: { path: 'y' } }));
      expect(await store.forgetClientFiles()).toBe(2);
      for (const stored of await store.getProjects()) expect(stored).not.toHaveProperty('clientFiles');
      expect(await store.forgetClientFiles()).toBe(0);
    });
  });

  describe('removing a project\'s records', () => {
    it('removes the project, its tasks and its secret requests, and says how many of each', async () => {
      const store = await make();
      await store.saveProject(project('p1'));
      await store.saveProject(project('p2'));
      await store.saveTask(task('t1', { projectId: 'p1' }));
      await store.saveTask(task('t2', { projectId: 'p1', ownerId: 'owner-2' }));
      await store.saveTask(task('t3', { projectId: 'p2' }));
      await store.saveTask(task('t4'));
      await store.saveSecretRequest(request('r1', { projectId: 'p1' }));
      await store.saveSecretRequest(request('r2', { projectId: 'p2' }));
      expect(await store.removeProjectRecords('p1')).toEqual({ projects: 1, tasks: 2, secretRequests: 1 });
      expect(ids(await store.getProjects())).toEqual(['p2']);
      expect(ids(await store.getTasks())).toEqual(['t3', 't4']);
      expect(ids(await store.getSecretRequests('owner-1'))).toEqual(['r2']);
    });

    it('lists only what it removed, and nothing for a project it does not have', async () => {
      const store = await make();
      await store.saveProject(project('p1'));
      expect(await store.removeProjectRecords('p1')).toEqual({ projects: 1 });
      expect(await store.removeProjectRecords('p1')).toEqual({});
      expect(await store.removeProjectRecords('never')).toEqual({});
    });

    it('leaves the project\'s trees alone', async () => {
      const store = await make();
      await store.saveProject(project('p1'));
      await store.saveTree(tree('tree-1', { projectIds: ['p1'] }));
      await store.removeProjectRecords('p1');
      expect(ids(await store.getTrees())).toEqual(['tree-1']);
    });
  });

  describe('tree types', () => {
    it('keeps a tree type as it was saved, replaces it whole, and forgets it when deleted', async () => {
      const store = await make();
      await store.saveTreeType(treeType('odoo'));
      await store.saveTreeType(treeType('api'));
      expect(await store.getTreeTypes()).toEqual(expect.arrayContaining([treeType('odoo'), treeType('api')]));
      await store.saveTreeType(treeType('odoo', { label: 'Odoo 20' }));
      const all = await store.getTreeTypes();
      expect(all).toHaveLength(2);
      expect(all.find((type) => type.id === 'odoo')?.label).toBe('Odoo 20');
      await store.deleteTreeType('odoo', 'owner-1');
      expect((await store.getTreeTypes()).map((type) => type.id)).toEqual(['api']);
    });

    it('keeps a tree type per owner, so two owners may each have the same id', async () => {
      const store = await make();
      await store.saveTreeType(treeType('odoo', { ownerId: 'owner-1', label: 'one' }));
      await store.saveTreeType(treeType('odoo', { ownerId: 'owner-2', label: 'two' }));
      expect(await store.getTreeTypes()).toHaveLength(2);
      await store.deleteTreeType('odoo', 'owner-1');
      expect(await store.getTreeTypes()).toEqual([treeType('odoo', { ownerId: 'owner-2', label: 'two' })]);
      await store.deleteTreeType('odoo', 'owner-1');
      await store.deleteTreeType('never', 'owner-2');
      expect(await store.getTreeTypes()).toHaveLength(1);
    });

    it('lists an owner\'s tree types and the ones that belong to no owner, never another\'s', async () => {
      const store = await make();
      await store.saveTreeType(treeType('mine', { ownerId: 'owner-1' }));
      await store.saveTreeType(treeType('theirs', { ownerId: 'owner-2' }));
      const shipped = treeType('shipped');
      delete (shipped as Partial<TreeTypeSpec>).ownerId;
      await store.saveTreeType(shipped);
      expect((await store.getTreeTypes('owner-1')).map((type) => type.id).sort()).toEqual(['mine', 'shipped']);
      expect((await store.getTreeTypes('owner-3')).map((type) => type.id)).toEqual(['shipped']);
      expect((await store.getTreeTypes()).map((type) => type.id).sort()).toEqual(['mine', 'shipped', 'theirs']);
    });

    it('hands back a copy', async () => {
      const store = await make();
      await store.saveTreeType(treeType('odoo'));
      const [read] = await store.getTreeTypes();
      read!.files.push({ path: 'extra', content: '' });
      read!.label = 'changed';
      expect(await store.getTreeTypes()).toEqual([treeType('odoo')]);
    });
  });

  describe('Gitea tokens to revoke', () => {
    it('keeps each token until it is dropped, apart by user and name', async () => {
      const store = await make();
      const token = { name: 'koala-run-1', ownerId: 'owner-1', username: 'person', process: 'backend-a', at: at(0) };
      await store.saveTokenToRevoke(token);
      await store.saveTokenToRevoke({ ...token, username: 'other', ownerId: 'owner-2' });
      await store.saveTokenToRevoke(token);
      expect((await store.getTokensToRevoke()).sort((a, b) => a.username.localeCompare(b.username))).toEqual([{ ...token, username: 'other', ownerId: 'owner-2' }, token]);
      await store.dropTokenToRevoke(token);
      expect(await store.getTokensToRevoke()).toEqual([{ ...token, username: 'other', ownerId: 'owner-2' }]);
    });
  });

  describe('Gitea accounts', () => {
    const account = { ownerId: 'owner-1', username: 'person', passwordEnc: 'sealed', createdAt: at(0) };

    it('keeps an owner\'s account, replaces it when saved again, and has none for anyone else', async () => {
      const store = await make();
      expect(await store.getGiteaAccount('owner-1')).toBeNull();
      await store.saveGiteaAccount(account);
      expect(await store.getGiteaAccount('owner-1')).toEqual(account);
      expect(await store.getGiteaAccount('owner-2')).toBeNull();
      await store.saveGiteaAccount({ ...account, username: 'renamed', passwordEnc: 'new' });
      expect(await store.getGiteaAccount('owner-1')).toEqual({ ...account, username: 'renamed', passwordEnc: 'new' });
    });

    it('claims an account once, so a second claim gets the first one back', async () => {
      const store = await make();
      expect(await store.claimGiteaAccount(account)).toEqual(account);
      const second = { ...account, username: 'other', passwordEnc: 'other', createdAt: at(9) };
      expect(await store.claimGiteaAccount(second)).toEqual(account);
      expect(await store.getGiteaAccount('owner-1')).toEqual(account);
    });

    it('claims past an account that was saved first', async () => {
      const store = await make();
      await store.saveGiteaAccount(account);
      expect(await store.claimGiteaAccount({ ...account, username: 'other' })).toEqual(account);
    });

    it('hands the same account to two claims made at once', async () => {
      const store = await make();
      const [first, second] = await Promise.all([
        store.claimGiteaAccount({ ...account, username: 'first' }),
        store.claimGiteaAccount({ ...account, username: 'second' }),
      ]);
      expect(first).toEqual(second);
      expect(await store.getGiteaAccount('owner-1')).toEqual(first);
    });
  });

  describe('trees, features and stories', () => {
    it('keeps a tree as it was saved, replaces it whole, and forgets it when deleted', async () => {
      const store = await make();
      await store.saveTree(tree('a', { goal: 'ship', projectIds: ['p1'], models: { judge: 'm' } }));
      await store.saveTree(tree('b', { ownerId: 'owner-2' }));
      expect(ids(await store.getTrees())).toEqual(['a', 'b']);
      expect((await store.getTrees()).find((stored) => stored.id === 'a')).toEqual(tree('a', { goal: 'ship', projectIds: ['p1'], models: { judge: 'm' } }));
      await store.saveTree(tree('a', { name: 'renamed' }));
      const replaced = (await store.getTrees()).find((stored) => stored.id === 'a');
      expect(replaced).toEqual(tree('a', { name: 'renamed' }));
      expect(replaced).not.toHaveProperty('goal');
      await store.deleteTree('a');
      await store.deleteTree('never');
      expect(ids(await store.getTrees())).toEqual(['b']);
    });

    it('keeps a branch as it was saved, replaces it whole, and forgets it when deleted', async () => {
      const store = await make();
      await store.saveBranch(branch('a', { priority: 2 }));
      await store.saveBranch(branch('b', { treeId: 'tree-2' }));
      expect(ids(await store.getBranches())).toEqual(['a', 'b']);
      expect((await store.getBranches()).find((stored) => stored.id === 'a')).toEqual(branch('a', { priority: 2 }));
      await store.saveBranch(branch('a', { title: 'renamed' }));
      const replaced = (await store.getBranches()).find((stored) => stored.id === 'a');
      expect(replaced).toEqual(branch('a', { title: 'renamed' }));
      expect(replaced).not.toHaveProperty('priority');
      await store.deleteBranch('a');
      await store.deleteBranch('never');
      expect(ids(await store.getBranches())).toEqual(['b']);
    });

    it('keeps a story as it was saved, replaces it whole, and forgets it when deleted', async () => {
      const store = await make();
      const claimed = leaf('a', { status: 'claimed', dependsOn: ['b'], claim: { evidence: 'done', files: ['x.ts'], at: at(3) }, waitingFor: { reason: 'a build', since: at(4) } });
      await store.saveLeaf(claimed);
      await store.saveLeaf(leaf('b'));
      expect(ids(await store.getLeaves())).toEqual(['a', 'b']);
      expect((await store.getLeaves()).find((stored) => stored.id === 'a')).toEqual(claimed);
      await store.saveLeaf(leaf('a', { status: 'succeeded' }));
      const replaced = (await store.getLeaves()).find((stored) => stored.id === 'a');
      expect(replaced).toEqual(leaf('a', { status: 'succeeded' }));
      expect(replaced).not.toHaveProperty('claim');
      await store.deleteLeaf('a');
      await store.deleteLeaf('never');
      expect(ids(await store.getLeaves())).toEqual(['b']);
    });

    it('deletes only the record it is told to, leaving the tree\'s branches and stories', async () => {
      const store = await make();
      await store.saveTree(tree('tree-1'));
      await store.saveBranch(branch('branch-1'));
      await store.saveLeaf(leaf('leaf-1'));
      await store.deleteTree('tree-1');
      expect(ids(await store.getBranches())).toEqual(['branch-1']);
      expect(ids(await store.getLeaves())).toEqual(['leaf-1']);
    });

    it('hands back copies, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveTree(tree('a', { projectIds: ['p1'] }));
      await store.saveLeaf(leaf('a', { dependsOn: ['b'] }));
      (await store.getTrees())[0]!.projectIds!.push('p2');
      (await store.getLeaves())[0]!.dependsOn!.push('c');
      expect((await store.getTrees())[0]?.projectIds).toEqual(['p1']);
      expect((await store.getLeaves())[0]?.dependsOn).toEqual(['b']);
    });

    it('leaves out a field saved as undefined, nested ones too', async () => {
      const store = await make();
      await store.saveLeaf(leaf('a', { priority: undefined, waitingFor: { reason: 'r', since: at(1), stuck: undefined } }));
      const [stored] = await store.getLeaves();
      expect(stored).not.toHaveProperty('priority');
      expect(stored?.waitingFor).toEqual({ reason: 'r', since: at(1) });
    });
  });

  describe('tasks', () => {
    it('keeps a task as it was saved, replaces it whole, and forgets it when deleted', async () => {
      const store = await make();
      await store.saveTask(task('a', { projectId: 'p1', checks: { command: 'npm test', expects: ['ok'] }, runs: ['run-1'] }));
      await store.saveTask(task('b'));
      expect((await store.getTasks()).find((stored) => stored.id === 'a')).toEqual(task('a', { projectId: 'p1', checks: { command: 'npm test', expects: ['ok'] }, runs: ['run-1'] }));
      await store.saveTask(task('a', { status: 'done' }));
      const replaced = (await store.getTasks()).find((stored) => stored.id === 'a');
      expect(replaced).toEqual(task('a', { status: 'done' }));
      expect(replaced).not.toHaveProperty('checks');
      await store.deleteTask('a');
      await store.deleteTask('never');
      expect(ids(await store.getTasks())).toEqual(['b']);
    });

    it('lists every owner\'s tasks, or only the owner\'s it is asked for', async () => {
      const store = await make();
      await store.saveTask(task('a', { ownerId: 'owner-1' }));
      await store.saveTask(task('b', { ownerId: 'owner-2' }));
      await store.saveTask(task('c', { ownerId: 'owner-1' }));
      expect(ids(await store.getTasks())).toEqual(['a', 'b', 'c']);
      expect(ids(await store.getTasks('owner-1'))).toEqual(['a', 'c']);
      expect(ids(await store.getTasks('owner-2'))).toEqual(['b']);
      expect(await store.getTasks('owner-3')).toEqual([]);
    });

    it('hands back a copy', async () => {
      const store = await make();
      await store.saveTask(task('a', { runs: ['run-1'] }));
      (await store.getTasks())[0]!.runs.push('run-2');
      expect((await store.getTasks())[0]?.runs).toEqual(['run-1']);
    });
  });

  describe('plan proposals', () => {
    it('keeps a proposal as it was saved, replaces it whole, and finds it by its owner and id', async () => {
      const store = await make();
      await store.savePlanProposal(proposal('a', { conversationId: 'c1', reason: 'because' }));
      expect(await store.getPlanProposal('owner-1', 'a')).toEqual(proposal('a', { conversationId: 'c1', reason: 'because' }));
      await store.savePlanProposal(proposal('a', { status: 'adopted' }));
      const replaced = await store.getPlanProposal('owner-1', 'a');
      expect(replaced).toEqual(proposal('a', { status: 'adopted' }));
      expect(replaced).not.toHaveProperty('conversationId');
    });

    it('does not find a proposal for another owner, or one that is not there', async () => {
      const store = await make();
      await store.savePlanProposal(proposal('a'));
      expect(await store.getPlanProposal('owner-2', 'a')).toBeUndefined();
      expect(await store.getPlanProposal('owner-1', 'never')).toBeUndefined();
    });

    it('lists an owner\'s proposals oldest first, all of them or those of one conversation', async () => {
      const store = await make();
      await store.savePlanProposal(proposal('late', { conversationId: 'c1', createdAt: at(9) }));
      await store.savePlanProposal(proposal('early', { conversationId: 'c1', createdAt: at(1) }));
      await store.savePlanProposal(proposal('middle', { conversationId: 'c2', createdAt: at(5) }));
      await store.savePlanProposal(proposal('loose', { createdAt: at(3) }));
      await store.savePlanProposal(proposal('theirs', { ownerId: 'owner-2', conversationId: 'c1', createdAt: at(2) }));
      expect((await store.getPlanProposals('owner-1')).map((stored) => stored.id)).toEqual(['early', 'loose', 'middle', 'late']);
      expect((await store.getPlanProposals('owner-1', 'c1')).map((stored) => stored.id)).toEqual(['early', 'late']);
      expect((await store.getPlanProposals('owner-1', 'c2')).map((stored) => stored.id)).toEqual(['middle']);
      expect(await store.getPlanProposals('owner-1', 'nobody')).toEqual([]);
      expect((await store.getPlanProposals('owner-2')).map((stored) => stored.id)).toEqual(['theirs']);
    });

    it('deletes a proposal only for its owner', async () => {
      const store = await make();
      await store.savePlanProposal(proposal('a'));
      await store.deletePlanProposal('owner-2', 'a');
      expect(await store.getPlanProposal('owner-1', 'a')).toBeDefined();
      await store.deletePlanProposal('owner-1', 'never');
      await store.deletePlanProposal('owner-1', 'a');
      expect(await store.getPlanProposals('owner-1')).toEqual([]);
    });

    it('hands back a copy', async () => {
      const store = await make();
      await store.savePlanProposal(proposal('a', { reason: 'because' }));
      const read = await store.getPlanProposal('owner-1', 'a');
      read!.reason = 'changed';
      (await store.getPlanProposals('owner-1'))[0]!.status = 'failed';
      expect(await store.getPlanProposal('owner-1', 'a')).toEqual(proposal('a', { reason: 'because' }));
    });
  });

  describe('secret requests', () => {
    it('keeps a request as it was saved, replaces it whole, and finds it by its owner and id', async () => {
      const store = await make();
      await store.saveSecretRequest(request('a', { conversationId: 'c1', treeId: 't1' }));
      expect(await store.getSecretRequest('owner-1', 'a')).toEqual(request('a', { conversationId: 'c1', treeId: 't1' }));
      await store.saveSecretRequest(request('a', { status: 'provided' }));
      const replaced = await store.getSecretRequest('owner-1', 'a');
      expect(replaced).toEqual(request('a', { status: 'provided' }));
      expect(replaced).not.toHaveProperty('treeId');
    });

    it('does not find a request for another owner, or one that is not there', async () => {
      const store = await make();
      await store.saveSecretRequest(request('a'));
      expect(await store.getSecretRequest('owner-2', 'a')).toBeUndefined();
      expect(await store.getSecretRequest('owner-1', 'never')).toBeUndefined();
    });

    it('lists an owner\'s requests oldest first, narrowed by conversation, project and tree', async () => {
      const store = await make();
      await store.saveSecretRequest(request('c', { createdAt: at(3), projectId: 'p1', conversationId: 'c1', treeId: 't1' }));
      await store.saveSecretRequest(request('a', { createdAt: at(1), projectId: 'p1', conversationId: 'c2' }));
      await store.saveSecretRequest(request('b', { createdAt: at(2), projectId: 'p2', conversationId: 'c1', treeId: 't1' }));
      await store.saveSecretRequest(request('d', { createdAt: at(4), projectId: 'p1', ownerId: 'owner-2' }));
      const list = async (filter?: Parameters<ProjectsStore['getSecretRequests']>[1]): Promise<string[]> =>
        (await store.getSecretRequests('owner-1', filter)).map((stored) => stored.id);
      expect(await list()).toEqual(['a', 'b', 'c']);
      expect(await list({})).toEqual(['a', 'b', 'c']);
      expect(await list({ projectId: 'p1' })).toEqual(['a', 'c']);
      expect(await list({ conversationId: 'c1' })).toEqual(['b', 'c']);
      expect(await list({ treeId: 't1' })).toEqual(['b', 'c']);
      expect(await list({ projectId: 'p1', conversationId: 'c1' })).toEqual(['c']);
      expect(await list({ projectId: 'p2', treeId: 'nobody' })).toEqual([]);
      expect(await list({ projectId: undefined })).toEqual(['a', 'b', 'c']);
      expect((await store.getSecretRequests('owner-2')).map((stored) => stored.id)).toEqual(['d']);
    });

    it('deletes a request only for its owner', async () => {
      const store = await make();
      await store.saveSecretRequest(request('a'));
      await store.deleteSecretRequest('owner-2', 'a');
      expect(await store.getSecretRequest('owner-1', 'a')).toBeDefined();
      await store.deleteSecretRequest('owner-1', 'never');
      await store.deleteSecretRequest('owner-1', 'a');
      expect(await store.getSecretRequests('owner-1')).toEqual([]);
    });

    it('hands back a copy', async () => {
      const store = await make();
      await store.saveSecretRequest(request('a'));
      const read = await store.getSecretRequest('owner-1', 'a');
      read!.description = 'changed';
      (await store.getSecretRequests('owner-1'))[0]!.status = 'dismissed';
      expect(await store.getSecretRequest('owner-1', 'a')).toEqual(request('a'));
    });
  });

  describe('indexes', () => {
    it('can be asked for again without changing what is stored', async () => {
      const store = await make();
      await store.ensureIndexes();
      await store.saveProject(project('a'));
      await store.ensureIndexes();
      expect(await store.getProjects()).toEqual([project('a')]);
    });
  });
}

export function projectGroupContract(make: () => Promise<{ store: Pick<ProjectsStore, 'getProjectGroup'>; leftover(projectId: string, group: string): Promise<void> }>): void {
  describe('the group address a project kept from when it was shared', () => {
    it('is the group its leftover share named, and none for a project never shared', async () => {
      const { store, leftover } = await make();
      await leftover('shop', 'acme');
      expect(await store.getProjectGroup('shop')).toBe('acme');
      expect(await store.getProjectGroup('books')).toBeUndefined();
    });
  });
}
