import { decryptValue, encryptValue, type SecretKey } from '../lib/crypto.js';
import { inScope, scopeOf, type HubLink, type SyncedDoc, type SyncedKind } from '../lib/hub-sync.js';
import { hubConflictNotice } from '../lib/notices.js';
import { primaryProjectId } from '../lib/trees.js';
import type { Database } from '../lib/db-interface.js';
import type { ConversationNotice } from '../lib/conversations.js';
import type { HubRepoAccess } from './HubRepos.js';
import type { GitEnd } from './HubRepoSync.js';
import type { HubRepoSides } from './HubSyncService.js';
import type { HubService } from './HubService.js';

export interface HubSharing {
  reachable(): Promise<boolean>;
  share(owner: { id: string; email: string }, project: { id: string; name: string }): Promise<{ hubProjectId: string; repo?: HubRepoAccess | undefined }>;
  unshare(ownerId: string, hubProjectId: string): Promise<void>;
}

export interface SharingPreview {
  canShare: boolean;
  shared?: { hubProjectId: string; sharedAt: string } | undefined;
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

type Store = Pick<Database, 'getProjects' | 'getTrees' | 'getBranches' | 'getLeaves' | 'getConversations' | 'getTasks' | 'getPlanProposals' | 'getHubLinks' | 'saveHubLink' | 'deleteHubLink' | 'deleteHubSnapshots' | 'markForHub'>;

export interface ProjectSharingDeps {
  store: Store;
  sharing: HubSharing;
  sync: { once(): Promise<void> };
  dataKey: SecretKey;
  ownerRepo: (project: { giteaOwner: string; giteaRepo: string }) => Promise<GitEnd>;
  notify: (ownerId: string, scope: { projectId: string; treeId?: string | undefined }, notice: ConversationNotice) => Promise<unknown>;
  now?: (() => string) | undefined;
}

export class ProjectSharingService {
  constructor(private readonly deps: ProjectSharingDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async project(ownerId: string, projectId: string) {
    return (await this.deps.store.getProjects()).find((entry) => entry.id === projectId && entry.ownerId === ownerId);
  }

  private async scoped(ownerId: string, projectId: string) {
    const [trees, branches, leaves, conversations] = await Promise.all([
      this.deps.store.getTrees(), this.deps.store.getBranches(), this.deps.store.getLeaves(), this.deps.store.getConversations(),
    ]);
    const mine = <T extends { ownerId?: string | undefined }>(list: T[]) => list.filter((entry) => entry.ownerId === ownerId) as unknown as SyncedDoc[];
    const world = { trees: mine(trees), branches: mine(branches), leaves: mine(leaves), conversations: mine(conversations) };
    const scope = scopeOf(projectId, world);
    const tasks = (await this.deps.store.getTasks(ownerId) as unknown as SyncedDoc[]).filter((task) => inScope('tasks', task, scope));
    const proposals = (await this.deps.store.getPlanProposals(ownerId) as unknown as SyncedDoc[]).filter((proposal) => inScope('planProposals', proposal, scope));
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
    const link = (await this.deps.store.getHubLinks()).find((entry) => entry.projectId === projectId);
    const { count } = await this.scoped(ownerId, projectId);
    return {
      ok: true,
      value: {
        canShare: link ? true : await this.deps.sharing.reachable(),
        ...(link ? { shared: { hubProjectId: link.hubProjectId, sharedAt: link.sharedAt } } : {}),
        moves: {
          epics: count('trees'), features: count('branches'), stories: count('leaves'), tasks: count('tasks'), chats: count('conversations'),
          ...(project.giteaRepo ? { repository: project.giteaRepo } : {}),
        },
        stays: STAYS,
      },
    };
  }

  async share(owner: { id: string; email: string }, projectId: string): Promise<SharingOutcome<SharingPreview>> {
    const project = await this.project(owner.id, projectId);
    if (!project) return { ok: false, status: 404, why: 'There is no such project.' };
    if (!(await this.deps.store.getHubLinks()).some((entry) => entry.projectId === projectId)) {
      if (!await this.deps.sharing.reachable()) return { ok: false, status: 409, why: 'Sharing needs a hub, and this Koala has none.' };
      const shared = await this.deps.sharing.share(owner, { id: project.id, name: project.name });
      await this.deps.store.saveHubLink({
        projectId, ownerId: owner.id, hubProjectId: shared.hubProjectId, pulledThrough: 0, sharedAt: this.now(),
        ...(shared.repo && project.giteaOwner && project.giteaRepo ? { repo: { url: shared.repo.url, username: shared.repo.username, tokenEnc: encryptValue(shared.repo.token, this.deps.dataKey) } } : {}),
      });
      const { records } = await this.scoped(owner.id, projectId);
      for (const [kind, docs] of records) for (const doc of docs) await this.deps.store.markForHub(kind, doc.id, false);
    }
    await this.deps.sync.once();
    return this.preview(owner.id, projectId);
  }

  async takeBack(ownerId: string, projectId: string, confirm: unknown): Promise<SharingOutcome<SharingPreview>> {
    const project = await this.project(ownerId, projectId);
    if (!project) return { ok: false, status: 404, why: 'There is no such project.' };
    if (typeof confirm !== 'string' || confirm.trim() !== project.name) return { ok: false, status: 400, why: `Type the project's name, ${project.name}, to take it back.` };
    const link = (await this.deps.store.getHubLinks()).find((entry) => entry.projectId === projectId);
    if (!link) return { ok: false, status: 409, why: `${project.name} is not shared.` };
    await this.release(ownerId, link);
    return this.preview(ownerId, projectId);
  }

  async shared(projectId: string): Promise<boolean> {
    return (await this.deps.store.getHubLinks()).some((entry) => entry.projectId === projectId);
  }

  async takeBackForDeletion(ownerId: string, projectId: string): Promise<void> {
    const link = (await this.deps.store.getHubLinks()).find((entry) => entry.projectId === projectId && entry.ownerId === ownerId);
    if (link) await this.release(ownerId, link);
  }

  private async release(ownerId: string, link: HubLink): Promise<void> {
    await this.deps.sync.once();
    await this.deps.sharing.unshare(ownerId, link.hubProjectId);
    await this.deps.store.deleteHubLink(link.projectId);
    await this.deps.store.deleteHubSnapshots(link.projectId);
  }

  repoSides(): HubRepoSides {
    return {
      ends: async (link: HubLink) => {
        const project = (await this.deps.store.getProjects()).find((entry) => entry.id === link.projectId);
        if (!link.repo || !project?.giteaOwner || !project.giteaRepo) return undefined;
        return {
          owner: await this.deps.ownerRepo({ giteaOwner: project.giteaOwner, giteaRepo: project.giteaRepo }),
          hub: { url: link.repo.url, auth: { username: link.repo.username, token: decryptValue(link.repo.tokenEnc, this.deps.dataKey) } },
        };
      },
      conflicted: async (link, conflict) => {
        const project = (await this.deps.store.getProjects()).find((entry) => entry.id === link.projectId);
        if (!project) return;
        const treeId = (await this.deps.store.getTrees()).find((tree) => primaryProjectId(tree) === project.id)?.id;
        await this.deps.notify(link.ownerId, { projectId: project.id, ...(treeId ? { treeId } : {}) }, hubConflictNotice(project, conflict, treeId));
      },
    };
  }
}

export function localHubSharing(hub: { share: HubService['share']; unshare: HubService['unshare'] }, instanceId: string): HubSharing {
  return {
    reachable: async () => true,
    async share(owner, project) {
      const outcome = await hub.share({ kind: 'instance', personId: owner.id, instanceId, email: owner.email }, { name: project.name, projectId: project.id });
      if (!outcome.ok) throw new Error(outcome.why);
      return { hubProjectId: outcome.value.view.project.id, ...(outcome.value.repo ? { repo: outcome.value.repo } : {}) };
    },
    async unshare(ownerId, hubProjectId) {
      const outcome = await hub.unshare({ kind: 'instance', personId: ownerId, instanceId }, hubProjectId);
      if (!outcome.ok && outcome.status !== 404) throw new Error(outcome.why);
    },
  };
}
