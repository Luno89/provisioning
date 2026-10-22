import type express from 'express';
import type { Database } from '../../platform/lib/db-interface.js';
import type { SecretKey } from '../../platform/lib/crypto.js';
import { holdsAccounts, servesHub, servesTenants, type RoleConfig } from '../../platform/lib/platform-role.js';
import { mongoTarget } from '../../platform/lib/mongo-db.js';
import { memoryHubStore } from '../lib/hub-store.js';
import { mongoHubStore } from '../lib/hub-mongo.js';
import { HUB_STATUS_BUILDS } from '../lib/hub-board.js';
import { runsUnder } from '../../engine/lib/turn-log.js';
import type { ConversationNotice } from '../../engine/lib/conversations.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import { hashCredential } from '../../instances/services/InstanceService.js';
import { HubService } from '../services/HubService.js';
import { HubRootClient } from '../services/HubRootClient.js';
import { HubRelay } from '../services/HubRelay.js';
import { giteaHubRepos } from '../services/HubRepos.js';
import { RemoteHub, RootHubAccess } from '../services/HubRemote.js';
import { HubSyncService, localHubSync } from '../services/HubSyncService.js';
import { HubInstanceWork, type HubInstanceWorkDeps } from '../services/HubInstanceWork.js';
import { localHubSharing, ProjectSharingService } from '../../projects/services/ProjectSharingService.js';
import { localHubPeople, RemoteHubPeople, type HubPeople } from '../services/HubPeople.js';
import { ProjectInviteService } from '../services/ProjectInviteService.js';
import { decideTask, type Accepted } from '../services/TaskDecisions.js';
import { extensionSummary } from '../../engine/routes/engine.js';
import type { GiteaService } from '../../projects/services/GiteaService.js';
import type { MailService } from '../../platform/services/MailService.js';
import { hubRouter } from '../routes/hub.js';
import { hubLinkRouter } from '../routes/hub-link.js';
import { hubRootRouter } from '../routes/hub-root.js';
import { hubInstanceRouter } from '../routes/hub-instance.js';
import { projectSharingRouter } from '../routes/project-sharing.js';

export type Mounts = { use(path: string, router: express.Router): unknown };

export interface HubWiringDeps {
  role: RoleConfig;
  env: NodeJS.ProcessEnv;
  app: Mounts;
  tenant: Mounts;
  db: Database;
  mail: MailService;
  publicUrl: string;
  dataKey: SecretKey;
  gitea: Pick<GiteaService, 'ensureOrg' | 'ensureOrgRepo' | 'letWrite' | 'createUserAccount' | 'createPushToken' | 'deleteUser' | 'deleteRepo' | 'deleteOrg' | 'repoGitUrl' | 'listPaths' | 'getRawFile' | 'getAdminCredentials'>;
  notify: (ownerId: string, scope: { projectId: string; treeId?: string | undefined }, notice: ConversationNotice) => Promise<unknown>;
  syncEveryMs?: number | undefined;
}

export interface HubWiring {
  hubService: HubService | undefined;
  hubPeople: HubPeople | undefined;
  sharingService: ProjectSharingService | undefined;
  reaches: boolean;
  setWork(work: HubInstanceWork): void;
}

export async function wireHub(deps: HubWiringDeps): Promise<HubWiring> {
  const { role, env, app, tenant, db } = deps;
  const projectInvites = holdsAccounts(role) ? new ProjectInviteService({ invites: db.accounts, mail: deps.mail, rootUrl: deps.publicUrl }) : undefined;
  if (projectInvites) app.use('/api/hub-link', hubLinkRouter({ invites: projectInvites, credentialHash: role.hubLink?.credentialHash, hash: hashCredential }));

  let hubService: HubService | undefined;
  if (servesHub(role)) {
    const hubStore = env.NODE_ENV === 'test' && env.IS_E2E !== 'true'
      ? memoryHubStore()
      : mongoHubStore(mongoTarget(env).uri, env.HUB_DATABASE?.trim() || 'koala_hub');
    await hubStore.init();
    const sender = role.hub ? new HubRootClient(role.hub) : projectInvites;
    if (!sender) throw new Error('a hub needs root to send its invites');
    hubService = new HubService({ store: hubStore, invites: sender, repos: giteaHubRepos(deps.gitea), relay: new HubRelay() });
    app.use('/api/hub', hubRouter({ hub: hubService }));
    if (role.role === 'hub' && role.trusted) app.use('/api/hub-instance', hubInstanceRouter({ hub: hubService, trusted: role.trusted }));
    if (role.role === 'hub' && role.trusted) app.use('/api/hub-root', hubRootRouter({ hub: hubService, trusted: role.trusted, forget: (id) => db.accounts.deleteUser(id) }));
  }

  const remoteHub = role.instance && env.INSTANCE_CREDENTIAL
    ? new RemoteHub(new RootHubAccess({ rootUrl: role.instance.rootUrl, instanceId: role.instance.id, credential: env.INSTANCE_CREDENTIAL }))
    : undefined;
  const reach = servesTenants(role) && hubService
    ? { instanceId: 'combined', transport: localHubSync(hubService, 'combined'), sharing: localHubSharing(hubService, 'combined') }
    : servesTenants(role) && remoteHub && role.instance
      ? { instanceId: role.instance.id, transport: remoteHub, sharing: remoteHub }
      : undefined;

  let work: HubInstanceWork | undefined;
  let sharingService: ProjectSharingService | undefined;
  if (reach) {
    const hubSync = new HubSyncService({
      store: db.hub,
      transport: reach.transport,
      origin: `instance:${reach.instanceId}`,
      work: () => work,
      repos: {
        ends: (link) => sharingService!.repoSides().ends(link),
        conflicted: (link, conflict) => sharingService!.repoSides().conflicted(link, conflict),
      },
      log: (line) => console.warn(`[HubSync] ${line}`),
    });
    sharingService = new ProjectSharingService({
      store: db,
      sharing: reach.sharing,
      sync: hubSync,
      dataKey: deps.dataKey,
      ownerRepo: async (project) => {
        const admin = await deps.gitea.getAdminCredentials();
        return { url: await deps.gitea.repoGitUrl(project.giteaOwner, project.giteaRepo), auth: { username: admin.username, token: admin.password } };
      },
      notify: deps.notify,
    });
    hubSync.start(deps.syncEveryMs ?? 3_000);
    tenant.use('/api/project-sharing', projectSharingRouter({ sharing: sharingService }));
  }

  const hubPeople: HubPeople | undefined = hubService
    ? localHubPeople(hubService)
    : role.hubLink && role.signing ? new RemoteHubPeople({ url: role.hubLink.url, signing: role.signing }) : undefined;

  return {
    hubService,
    hubPeople,
    sharingService,
    reaches: reach !== undefined,
    setWork: (given) => { work = given; },
  };
}

type Outcome = { ok: boolean; error?: string | undefined };
type Decided = { ok: true } | { ok: false; why: string };
const asDone = (outcome: Outcome): Decided => (outcome.ok ? { ok: true } : { ok: false, why: outcome.error ?? 'it could not be done' });

export interface HubWorkDeps {
  db: Database;
  releases: { list(ownerId: string, projectId: string): Promise<unknown[]>; addresses(projectId: string): Promise<unknown> };
  treeRuns: { status(ownerId: string, treeId: string): Promise<{ ok: true; value: unknown } | { ok: false }> };
  plans: { approve(ownerId: string, id: string): Promise<Outcome>; reject(ownerId: string, id: string, reason: string | undefined): Promise<Outcome> };
  order: { orderStories(ownerId: string, branchId: string, leafIds: string[]): Promise<Outcome>; orderFeatures(ownerId: string, treeId: string, branchIds: string[]): Promise<Outcome> };
  accepted: Accepted | undefined;
  itemChats: { ensure(ownerId: string, item: { kind: 'story'; leafId: string } | { kind: 'feature'; branchId: string }): Promise<unknown> };
  runs: { start(input: Record<string, unknown> & { ownerId: string; agentSlug: string; message: string }): Promise<unknown> };
  procedures: { get(ownerId: string, id: string): Promise<unknown> };
  extensions: { list(ownerId: string): Promise<Parameters<typeof extensionSummary>[0][]> };
  files: HubInstanceWorkDeps['files'];
}

export function hubInstanceWork(deps: HubWorkDeps): HubInstanceWork {
  const { db } = deps;
  return new HubInstanceWork({
    store: db,
    status: async (ownerId: string, project: ProjectMetadata, treeIds: readonly string[]) => {
      const [releases, addresses, runs, treeRuns] = await Promise.all([
        deps.releases.list(ownerId, project.id),
        deps.releases.addresses(project.id),
        db.releases.getPipelineRuns(),
        Promise.all(treeIds.map(async (treeId) => [treeId, await deps.treeRuns.status(ownerId, treeId)] as const)),
      ]);
      return {
        at: new Date().toISOString(),
        releases: releases as Record<string, unknown>[],
        ...(addresses ? { addresses: addresses as Record<string, unknown> } : {}),
        runs: runs.filter((run) => run.projectId === project.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, HUB_STATUS_BUILDS) as unknown as Record<string, unknown>[],
        treeRuns: Object.fromEntries(treeRuns.flatMap(([treeId, outcome]) => (outcome.ok ? [[treeId, outcome.value as Record<string, unknown>]] : []))),
      };
    },
    act: {
      approvePlan: async (ownerId, id) => asDone(await deps.plans.approve(ownerId, id)),
      rejectPlan: async (ownerId, id, reason) => asDone(await deps.plans.reject(ownerId, id, reason)),
      orderStories: async (ownerId, branchId, leafIds) => asDone(await deps.order.orderStories(ownerId, branchId, leafIds)),
      orderFeatures: async (ownerId, treeId, branchIds) => asDone(await deps.order.orderFeatures(ownerId, treeId, branchIds)),
      decideTask: async (ownerId, taskId, status) => ((await decideTask({ list: (owner) => db.projects.getTasks(owner), save: (task) => db.projects.saveTask(task) }, deps.accepted, ownerId, taskId, status)) ? { ok: true } : { ok: false, why: 'There is no such task.' }),
      openChat: async (ownerId, item) => ((await deps.itemChats.ensure(ownerId, item)) ? { ok: true } : { ok: false, why: `There is no such ${item.kind}.` }),
      askKoala: async (ownerId, conversation, note) => {
        try {
          await deps.runs.start({
            ownerId,
            agentSlug: typeof conversation.agentSlug === 'string' ? conversation.agentSlug : 'koala',
            message: note.content,
            inputs: { conversationId: conversation.id },
            conversationId: conversation.id,
            ...(typeof conversation.modelId === 'string' ? { modelId: conversation.modelId } : {}),
            ...(conversation.modelReach === 'handoffs' || conversation.modelReach === 'chat' ? { modelReach: conversation.modelReach } : {}),
            asks: note.at,
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, why: (err as Error).message };
        }
      },
    },
    live: {
      turns: async (ownerId, turnId, after, under) => {
        const entries = (await db.getTurnLog(ownerId, turnId, after)).map(({ ownerId: _ownerId, ...entry }) => entry);
        return under ? runsUnder(entries, under) : { entries };
      },
      procedure: async (ownerId, id) => (await deps.procedures.get(ownerId, id)) ?? undefined,
      extensions: async (ownerId) => (await deps.extensions.list(ownerId)).map(extensionSummary),
    },
    files: deps.files,
  });
}
