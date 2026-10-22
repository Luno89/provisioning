import { decryptValue, encryptValue, type SecretKey, hubConflictNotice, type Database } from '../../platform/index.js';
import { inScope, scopeOf, type HubLink, type SyncedDoc, type SyncedKind } from '../../hub/lib/hub-sync.js';
import { primaryProjectId } from '../lib/trees.js';
import { nameProblem, suggestedGroup } from '../../instances/lib/instance-names.js';
import { appLabel, flatHost, labelOfFlat } from '../../instances/lib/edge-addresses.js';
import type { ConversationNotice } from '../../engine/index.js';
import type { HubRepoAccess, GitEnd, HubRepoSides, HubService } from '../../hub/index.js';

export interface HubSharing {
  reachable(): Promise<boolean>;
  share(owner: { id: string; email: string }, project: { id: string; name: string; group: string }): Promise<{ hubProjectId: string; repo?: HubRepoAccess | undefined }>;
  unshare(ownerId: string, hubProjectId: string): Promise<void>;
}

export interface ProjectGroups {
  check(name: string): Promise<string | null>;
  claim(projectId: string, name: string): Promise<void>;
  release(projectId: string): Promise<void>;
}

export interface SharingAddresses {
  scope: 'owner' | 'group';
  example?: string | undefined;
}

export interface GroupCheck {
  ok: boolean;
  problem?: string | undefined;
  suggested: string;
  example?: string | undefined;
}

export interface SharingPreview {
  canShare: boolean;
  shared?: { hubProjectId: string; sharedAt: string } | undefined;
  group?: string | undefined;
  addresses: SharingAddresses;
  moves: { epics: number; features: number; stories: number; tasks: number; chats: number; repository?: string | undefined };
  stays: string[];
}

export type SharingOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; why: string };

const STAYS = [
  'your other chats with Koala',
  'the project\'s secrets',
  'its builds and releases, which still run on your instance',
  'the deployed app and its clusters',
];

type Store = Pick<Database, 'projects' | 'engine' | 'hub' | 'infrastructure'>;

export interface ProjectSharingDeps {
  store: Store;
  sharing: HubSharing;
  sync: { once(): Promise<void> };
  dataKey: SecretKey;
  ownerRepo: (project: { giteaOwner: string; giteaRepo: string }) => Promise<GitEnd>;
  notify: (ownerId: string, scope: { projectId: string; treeId?: string | undefined }, notice: ConversationNotice) => Promise<unknown>;
  groups: ProjectGroups;
  republish: () => Promise<void>;
  domain?: string | undefined;
  now?: (() => string) | undefined;
}

export class ProjectSharingService {
  constructor(private readonly deps: ProjectSharingDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async project(ownerId: string, projectId: string) {
    return (await this.deps.store.projects.getProjects()).find((entry) => entry.id === projectId && entry.ownerId === ownerId);
  }

  private async scoped(ownerId: string, projectId: string) {
    const [trees, branches, leaves, conversations] = await Promise.all([
      this.deps.store.projects.getTrees(), this.deps.store.projects.getBranches(), this.deps.store.projects.getLeaves(), this.deps.store.engine.getConversations(),
    ]);
    const mine = <T extends { ownerId?: string | undefined }>(list: T[]) => list.filter((entry) => entry.ownerId === ownerId) as unknown as SyncedDoc[];
    const world = { trees: mine(trees), branches: mine(branches), leaves: mine(leaves), conversations: mine(conversations) };
    const scope = scopeOf(projectId, world);
    const tasks = (await this.deps.store.projects.getTasks(ownerId) as unknown as SyncedDoc[]).filter((task) => inScope('tasks', task, scope));
    const proposals = (await this.deps.store.projects.getPlanProposals(ownerId) as unknown as SyncedDoc[]).filter((proposal) => inScope('planProposals', proposal, scope));
    const records: [SyncedKind, SyncedDoc[]][] = [
      ['trees', world.trees.filter((doc) => scope.treeIds.has(doc.id))],
      ['branches', world.branches.filter((doc) => scope.branchIds.has(doc.id))],
      ['leaves', world.leaves.filter((doc) => scope.leafIds.has(doc.id))],
      ['tasks', tasks],
      ['conversations', world.conversations.filter((doc) => scope.conversationIds.has(doc.id))],
      ['planProposals', proposals],
    ];
    return { records, count: (kind: SyncedKind) => records.find(([name]) => name === kind)![1].length };
  }

  async preview(ownerId: string, projectId: string): Promise<SharingOutcome<SharingPreview>> {
    const project = await this.project(ownerId, projectId);
    if (!project) return { ok: false, status: 404, why: 'There is no such project.' };
    const link = (await this.deps.store.hub.getHubLinks()).find((entry) => entry.projectId === projectId);
    const { count } = await this.scoped(ownerId, projectId);
    const example = link?.group ? await this.example(projectId, link.group) : undefined;
    return {
      ok: true,
      value: {
        canShare: link ? true : await this.deps.sharing.reachable(),
        ...(link ? { shared: { hubProjectId: link.hubProjectId, sharedAt: link.sharedAt } } : {}),
        ...(link?.group ? { group: link.group } : {}),
        addresses: { scope: link?.group ? 'group' : 'owner', ...(example ? { example } : {}) },
        moves: {
          epics: count('trees'), features: count('branches'), stories: count('leaves'), tasks: count('tasks'), chats: count('conversations'),
          ...(project.giteaRepo ? { repository: project.giteaRepo } : {}),
        },
        stays: STAYS,
      },
    };
  }

  private async example(projectId: string, group: string): Promise<string | undefined> {
    const domain = this.deps.domain;
    if (!domain) return undefined;
    const app = (await this.deps.store.infrastructure.getDeployments()).find((entry) => entry.gitappProjectId === projectId);
    if (!app) return flatHost('<app>', group, domain);
    if (app.publicHostname && labelOfFlat(app.publicHostname, group, domain)) return app.publicHostname;
    return flatHost(appLabel(app.name), group, domain);
  }

  private async groupProblem(projectId: string, name: string): Promise<{ status: 400 | 409; why: string } | undefined> {
    const problem = nameProblem(name);
    if (problem) return { status: 400, why: problem };
    const holder = (await this.deps.store.hub.getHubLinks()).find((entry) => entry.group === name);
    if (holder && holder.projectId !== projectId) return { status: 409, why: `"${name}" is taken` };
    return undefined;
  }

  async groupCheck(ownerId: string, projectId: string, name: unknown): Promise<SharingOutcome<GroupCheck>> {
    const project = await this.project(ownerId, projectId);
    if (!project) return { ok: false, status: 404, why: 'There is no such project.' };
    const suggested = suggestedGroup(project.name);
    if (typeof name !== 'string' || !name) return { ok: true, value: { ok: false, suggested } };
    const local = await this.groupProblem(projectId, name);
    const held = (await this.deps.store.hub.getHubLinks()).find((entry) => entry.projectId === projectId)?.group === name;
    const problem = local?.why ?? (held ? null : await this.deps.groups.check(name));
    if (problem) return { ok: true, value: { ok: false, problem, suggested } };
    const example = await this.example(projectId, name);
    return { ok: true, value: { ok: true, suggested, ...(example ? { example } : {}) } };
  }

  async share(owner: { id: string; email: string }, projectId: string, group: unknown): Promise<SharingOutcome<SharingPreview>> {
    const project = await this.project(owner.id, projectId);
    if (!project) return { ok: false, status: 404, why: 'There is no such project.' };
    if (!(await this.deps.store.hub.getHubLinks()).some((entry) => entry.projectId === projectId)) {
      if (typeof group !== 'string' || !group) return { ok: false, status: 400, why: 'Name the group the project\'s apps are addressed under while it is shared.' };
      const refused = await this.groupProblem(projectId, group);
      if (refused) return { ok: false, ...refused };
      if (!await this.deps.sharing.reachable()) return { ok: false, status: 409, why: 'Sharing needs a hub, and this Koala has none.' };
      try {
        await this.deps.groups.claim(projectId, group);
      } catch (err) {
        return { ok: false, status: 409, why: (err as Error).message };
      }
      let shared: Awaited<ReturnType<HubSharing['share']>>;
      try {
        shared = await this.deps.sharing.share(owner, { id: project.id, name: project.name, group });
      } catch (err) {
        await this.deps.groups.release(projectId).catch(() => {});
        throw err;
      }
      await this.deps.store.hub.saveHubLink({
        projectId, ownerId: owner.id, hubProjectId: shared.hubProjectId, pulledThrough: 0, sharedAt: this.now(), group,
        ...(shared.repo && project.giteaOwner && project.giteaRepo ? { repo: { url: shared.repo.url, username: shared.repo.username, tokenEnc: encryptValue(shared.repo.token, this.deps.dataKey) } } : {}),
      });
      const { records } = await this.scoped(owner.id, projectId);
      for (const [kind, docs] of records) for (const doc of docs) await this.deps.store.hub.markForHub(kind, doc.id, false);
      await this.deps.republish();
    }
    await this.deps.sync.once();
    return this.preview(owner.id, projectId);
  }

  async takeBack(ownerId: string, projectId: string, confirm: unknown): Promise<SharingOutcome<SharingPreview>> {
    const project = await this.project(ownerId, projectId);
    if (!project) return { ok: false, status: 404, why: 'There is no such project.' };
    if (typeof confirm !== 'string' || confirm.trim() !== project.name) return { ok: false, status: 400, why: `Type the project's name, ${project.name}, to take it back.` };
    const link = (await this.deps.store.hub.getHubLinks()).find((entry) => entry.projectId === projectId);
    if (!link) return { ok: false, status: 409, why: `${project.name} is not shared.` };
    await this.release(ownerId, link);
    return this.preview(ownerId, projectId);
  }

  async shared(projectId: string): Promise<boolean> {
    return (await this.deps.store.hub.getHubLinks()).some((entry) => entry.projectId === projectId);
  }

  async takeBackForDeletion(ownerId: string, projectId: string): Promise<void> {
    const link = (await this.deps.store.hub.getHubLinks()).find((entry) => entry.projectId === projectId && entry.ownerId === ownerId);
    if (link) await this.release(ownerId, link);
  }

  private async release(ownerId: string, link: HubLink): Promise<void> {
    await this.deps.sync.once();
    await this.deps.sharing.unshare(ownerId, link.hubProjectId);
    await this.deps.store.hub.deleteHubLink(link.projectId);
    await this.deps.store.hub.deleteHubSnapshots(link.projectId);
    if (link.group) {
      await this.deps.groups.release(link.projectId);
      await this.deps.republish();
    }
  }

  repoSides(): HubRepoSides {
    return {
      ends: async (link: HubLink) => {
        const project = (await this.deps.store.projects.getProjects()).find((entry) => entry.id === link.projectId);
        if (!link.repo || !project?.giteaOwner || !project.giteaRepo) return undefined;
        return {
          owner: await this.deps.ownerRepo({ giteaOwner: project.giteaOwner, giteaRepo: project.giteaRepo }),
          hub: { url: link.repo.url, auth: { username: link.repo.username, token: decryptValue(link.repo.tokenEnc, this.deps.dataKey) } },
        };
      },
      conflicted: async (link, conflict) => {
        const project = (await this.deps.store.projects.getProjects()).find((entry) => entry.id === link.projectId);
        if (!project) return;
        const treeId = (await this.deps.store.projects.getTrees()).find((tree) => primaryProjectId(tree) === project.id)?.id;
        await this.deps.notify(link.ownerId, { projectId: project.id, ...(treeId ? { treeId } : {}) }, hubConflictNotice(project, conflict, treeId));
      },
    };
  }
}

export function localHubSharing(hub: { share: HubService['share']; unshare: HubService['unshare'] }, instanceId: string): HubSharing {
  return {
    reachable: async () => true,
    async share(owner, project) {
      const outcome = await hub.share({ kind: 'instance', personId: owner.id, instanceId, email: owner.email }, { name: project.name, projectId: project.id, group: project.group });
      if (!outcome.ok) throw new Error(outcome.why);
      return { hubProjectId: outcome.value.view.project.id, ...(outcome.value.repo ? { repo: outcome.value.repo } : {}) };
    },
    async unshare(ownerId, hubProjectId) {
      const outcome = await hub.unshare({ kind: 'instance', personId: ownerId, instanceId }, hubProjectId);
      if (!outcome.ok && outcome.status !== 404) throw new Error(outcome.why);
    },
  };
}

export function localProjectGroups(store: Pick<Database, 'hub'>): ProjectGroups {
  const holder = async (name: string) => (await store.hub.getHubLinks()).find((entry) => entry.group === name);
  return {
    check: async (name) => ((await holder(name)) ? `"${name}" is taken` : null),
    async claim(projectId, name) {
      const held = await holder(name);
      if (held && held.projectId !== projectId) throw new Error(`"${name}" is taken`);
    },
    release: async () => {},
  };
}
