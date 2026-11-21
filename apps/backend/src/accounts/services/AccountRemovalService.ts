import { type AccessRevocations, type ClusterMetadata, type DeploymentMetadata, holds, type Principal, startedFor, type UserMetadata } from '../../platform/index.js';
import { dataHolds, type InstanceRecord, type InstanceRelease, type InstanceStatus, type InstanceWatchRecord } from '../../instances/index.js';
import type { Client } from '@temporalio/client';
import { ignore } from '@koala/engine-core/failures';
import type { AccountsStore } from '../store.js';
import { withWorkFor } from '@koala/engine-core/work-for';
import type { DeletionProgress } from '../../projects/index.js';
import {
  KOALA_REMOVAL_QUERY,
  KOALA_REMOVAL_SIGNAL,
  MACHINE_REMOVALS_QUERY,
  REMOVAL_PROGRESS_QUERY,
  type MachineRemoval,
  DELETE_ACCOUNT_WORKFLOW,
  refuseRemoval,
  removalBlockers,
  removeAccountWorkflowId,
  type RemovalRefusal,
  type RemovalRequest,
  type RemovalStep,
} from '../lib/account-removal.js';

export interface AccountRemovalStore {
  accounts: Pick<AccountsStore, 'getUsers' | 'getUserById' | 'saveUser'>;
  projects: { deletedProjects(ownerId: string): Promise<readonly unknown[]> };
  infrastructure: {
    getClusters(): Promise<ClusterMetadata[]>;
    getDeployments(): Promise<DeploymentMetadata[]>;
  };
}

export type RemovalWorkflowState<Step extends string = RemovalStep> = { state: 'running'; done: Step[] } | { state: 'failed'; reason: string } | { state: 'finished' } | { state: 'none' };

export interface AccountRemovalWorkflows<Args = { ownerId: string }, Step extends string = RemovalStep> {
  start(workflowType: string, workflowId: string, args: [Args], owner: string): Promise<void>;
  state(workflowId: string): Promise<RemovalWorkflowState<Step>>;
}

const innermost = (err: unknown): string | undefined => {
  let reason: string | undefined;
  for (let at = err as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
    if (typeof at.message === 'string' && at.message) reason = at.message;
  }
  return reason;
};

export function temporalRemovalWorkflows<Args = { ownerId: string }, Step extends string = RemovalStep>(
  client: () => Client | undefined | null | Promise<Client | undefined | null>,
  taskQueue: string,
  progressQuery: string = REMOVAL_PROGRESS_QUERY,
): AccountRemovalWorkflows<Args, Step> {
  return {
    async start(workflowType, workflowId, args, owner) {
      const temporal = await client();
      if (!temporal) throw new Error('Temporal is not reachable, so the account cannot be removed now');
      await temporal.workflow.start(workflowType, { workflowId, taskQueue, args, ...startedFor(owner) });
    },
    async state(workflowId) {
      const temporal = await client();
      if (!temporal) return { state: 'none' };
      const handle = temporal.workflow.getHandle(workflowId);
      const described = await handle.describe().catch((err: Error) => {
        if (/not\s*found/i.test(err.message)) return undefined;
        throw err;
      });
      if (!described) return { state: 'none' };
      if (described.status.name === 'RUNNING') return { state: 'running', done: (await handle.query<Step[]>(progressQuery).catch(ignore('the steps done are only shown while the removal runs; it still reads as running, and the next look asks again'))) ?? [] };
      if (described.status.name === 'COMPLETED') return { state: 'finished' };
      const fallback = described.status.name.toLowerCase();
      const reason = await handle.result().then(() => fallback, (err: unknown) => innermost(err) ?? fallback);
      return { state: 'failed', reason };
    },
  };
}

export interface AccountRemovalDeps {
  store: AccountRemovalStore;
  workflows: AccountRemovalWorkflows;
  workflowType?: string | undefined;
  steps?: readonly RemovalStep[] | undefined;
  instances?: (() => Promise<InstanceRecord[]>) | undefined;
  releases?: (() => Promise<InstanceRelease[]>) | undefined;
  currentRelease?: string | undefined;
  watches?: (() => Promise<InstanceWatchRecord[]>) | undefined;
  logouts?: (() => Promise<UndeliveredLogout[]>) | undefined;
  principalFor(user: Pick<UserMetadata, 'id' | 'roles'>): Principal;
  revocations?: Pick<AccessRevocations, 'revoked'> | undefined;
  machines?: (() => Promise<readonly RemovedMachine[]>) | undefined;
  koalas?: KoalaRemovals | undefined;
  now?: () => string;
}

export interface RemovedMachine {
  id: string;
  name: string;
  offSince?: string | undefined;
}

export interface KoalaRemovals {
  tell(instanceId: string): void;
  told(workflowId: string, progress: DeletionProgress): Promise<boolean>;
  progress(workflowId: string): Promise<DeletionProgress | undefined>;
  machines(workflowId: string): Promise<MachineRemoval[]>;
}

export function temporalKoalaRemovals(client: () => Client | Promise<Client>, tell: (instanceId: string) => void): KoalaRemovals {
  return {
    tell,
    async told(workflowId, progress) {
      try {
        await (await client()).workflow.getHandle(workflowId).signal(KOALA_REMOVAL_SIGNAL, progress);
        return true;
      } catch (err) {
        if (/not\s*found|already completed/i.test((err as Error).message)) return false;
        throw err;
      }
    },
    async progress(workflowId) {
      return (await client()).workflow.getHandle(workflowId).query<DeletionProgress | undefined>(KOALA_REMOVAL_QUERY);
    },
    async machines(workflowId) {
      return (await client()).workflow.getHandle(workflowId).query<MachineRemoval[]>(MACHINE_REMOVALS_QUERY);
    },
  };
}

export interface UndeliveredLogout {
  clientId: string;
  revokedAt: string;
  attempts?: number | undefined;
  lastError?: string | undefined;
  lastTriedAt?: string | undefined;
}

function signOutsUndelivered(instanceId: string, logouts: readonly UndeliveredLogout[]): { since: string; why: string } | undefined {
  const failed = logouts.filter((logout) => logout.clientId === instanceId && logout.lastError);
  if (!failed.length) return undefined;
  const since = failed.map((logout) => logout.revokedAt).sort()[0]!;
  const latest = [...failed].sort((a, b) => (b.lastTriedAt ?? '').localeCompare(a.lastTriedAt ?? ''))[0]!;
  return { since, why: latest.lastError! };
}

export interface PersonInstance {
  name?: string | undefined;
  status: InstanceStatus;
  detail?: string | undefined;
  url: string;
  version?: string | undefined;
  versionWithdrawn?: boolean | undefined;
  heldByData?: { version: string; needs: number } | undefined;
  autoUpdates?: boolean | undefined;
  unreachableSince?: string | undefined;
  signOutsUndelivered?: { since: string; why: string } | undefined;
}

export interface PersonEntry {
  id: string;
  email: string;
  operator: boolean;
  createdAt: string;
  instance?: PersonInstance | undefined;
  removal?: {
    startedAt: string;
    requestedBy: string;
    state: RemovalWorkflowState;
    steps?: readonly RemovalStep[] | undefined;
    koala?: DeletionProgress | undefined;
    koalaAway?: { machine?: string | undefined; since?: string | undefined } | undefined;
    machinesAway?: { machine: string; since: string }[] | undefined;
  } | undefined;
}

function instanceOf(instance: InstanceRecord, releases: readonly InstanceRelease[] = [], watch?: InstanceWatchRecord, logouts: readonly UndeliveredLogout[] = [], current?: string): PersonInstance {
  const undelivered = signOutsUndelivered(instance.id, logouts);
  const [held] = current ? dataHolds([instance], releases, current) : [];
  return {
    ...(instance.name ? { name: instance.name } : {}),
    status: instance.status ?? (instance.url ? 'ready' : 'waiting'),
    ...(instance.detail ? { detail: instance.detail } : {}),
    url: instance.url,
    ...(instance.running ? { version: releases.find((release) => release.imageTag === instance.running)?.version ?? instance.running } : {}),
    ...(releases.some((release) => release.imageTag === instance.running && release.withdrawn) ? { versionWithdrawn: true } : {}),
    ...(held ? { heldByData: { version: held.release.version, needs: held.needs } } : {}),
    ...(instance.status === 'waiting' ? {} : { autoUpdates: instance.updates?.auto ?? true }),
    ...(watch?.reach?.toldDown && !watch.reach.reachable ? { unreachableSince: watch.reach.unreachableSince } : {}),
    ...(undelivered ? { signOutsUndelivered: undelivered } : {}),
  };
}

export class AccountRemovalService {
  constructor(private readonly deps: AccountRemovalDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async world() {
    const [users, clusters, deployments] = await Promise.all([this.deps.store.accounts.getUsers(), this.deps.store.infrastructure.getClusters(), this.deps.store.infrastructure.getDeployments()]);
    return { users: users.map((user) => ({ ...user, operator: this.operator(user) })), clusters, deployments };
  }

  private operator(user: Pick<UserMetadata, 'id' | 'roles'>): boolean {
    return holds(this.deps.principalFor(user), 'operator');
  }

  async preview(ownerId: string): Promise<{ email: string; blockers: string[]; instance?: PersonInstance; deletedProjects?: number } | undefined> {
    const world = await this.world();
    const user = world.users.find((entry) => entry.id === ownerId);
    if (!user) return undefined;
    const instance = this.deps.instances ? (await this.deps.instances()).find((entry) => entry.ownerId === ownerId) : undefined;
    const blockers = removalBlockers(ownerId, world);
    const deletedProjects = (await this.deps.store.projects.deletedProjects(ownerId)).length;
    return { email: user.email, blockers, ...(instance ? { instance: instanceOf(instance) } : {}), ...(deletedProjects > 0 ? { deletedProjects } : {}) };
  }

  async remove(request: RemovalRequest, requester: Principal, proven?: () => Promise<RemovalRefusal | undefined>): Promise<{ ok: true; state: RemovalWorkflowState } | { ok: false; refusal: RemovalRefusal }> {
    const world = await this.world();
    const target = world.users.find((entry) => entry.id === request.ownerId);
    const refusal = refuseRemoval(request, { ...world, requester });
    if (refusal) return { ok: false, refusal };

    const workflowId = removeAccountWorkflowId(request.ownerId);
    const current = await this.deps.workflows.state(workflowId);
    if (current.state === 'running') {
      await this.tellKoala(request.ownerId);
      return { ok: true, state: current };
    }
    const unproven = await proven?.();
    if (unproven) return { ok: false, refusal: unproven };
    const startedAt = this.now();
    await this.deps.store.accounts.saveUser({ ...target!, removal: { startedAt, requestedBy: request.requestedBy } });
    await this.deps.revocations?.revoked({ personId: request.ownerId, because: 'account-removed', at: startedAt });
    await withWorkFor({ owner: request.ownerId, removing: 'owner' }, () => this.deps.workflows.start(this.deps.workflowType ?? DELETE_ACCOUNT_WORKFLOW, workflowId, [{ ownerId: request.ownerId }], request.ownerId));
    await this.tellKoala(request.ownerId);
    return { ok: true, state: await this.deps.workflows.state(workflowId) };
  }

  private async tellKoala(ownerId: string): Promise<void> {
    const koalas = this.deps.koalas;
    if (!koalas || !this.deps.instances) return;
    for (const instance of (await this.deps.instances()).filter((entry) => entry.ownerId === ownerId)) koalas.tell(instance.id);
  }

  async ownerRemoving(ownerId: string): Promise<boolean> {
    return Boolean((await this.deps.store.accounts.getUserById(ownerId))?.removal);
  }

  async koalaTold(ownerId: string, progress: DeletionProgress): Promise<{ ok: true; value: Record<string, never> } | { ok: false; status: number; error: string }> {
    if (!this.deps.koalas) return { ok: false, status: 404, error: 'this server removes no accounts through their Koala' };
    if (!(await this.deps.koalas.told(removeAccountWorkflowId(ownerId), progress))) return { ok: false, status: 409, error: 'root is not removing this account now' };
    return { ok: true, value: {} };
  }

  private async koalaOf(ownerId: string, state: RemovalWorkflowState, instances: readonly InstanceRecord[], watches: readonly InstanceWatchRecord[], machines: readonly RemovedMachine[]) {
    if (state.state !== 'running' || !this.deps.koalas) return {};
    const koala = await this.deps.koalas.progress(removeAccountWorkflowId(ownerId));
    const instance = instances.find((entry) => entry.ownerId === ownerId);
    const reach = instance ? watches.find((watch) => watch.instanceId === instance.id)?.reach : undefined;
    const machine = instance?.machineId ? machines.find((entry) => entry.id === instance.machineId)?.name : undefined;
    const away = koala?.phase !== 'deleted' && reach && !reach.reachable ? { koalaAway: { ...(machine ? { machine } : {}), ...(reach.unreachableSince ? { since: reach.unreachableSince } : {}) } } : {};
    const machinesAway = (await this.deps.koalas.machines(removeAccountWorkflowId(ownerId))).flatMap((removal) => {
      const offSince = removal.state === 'uninstalling' ? machines.find((entry) => entry.id === removal.id)?.offSince : undefined;
      return offSince ? [{ machine: removal.name, since: offSince }] : [];
    });
    return { ...(koala ? { koala } : {}), ...away, ...(machinesAway.length ? { machinesAway } : {}) };
  }

  async people(): Promise<PersonEntry[]> {
    const users = (await this.deps.store.accounts.getUsers()).filter((user) => !user.space);
    const instances = this.deps.instances ? await this.deps.instances() : [];
    const releases = this.deps.releases ? await this.deps.releases() : [];
    const watches = this.deps.watches ? await this.deps.watches() : [];
    const logouts = this.deps.logouts ? await this.deps.logouts() : [];
    const steps = this.deps.steps;
    const machines = this.deps.machines && users.some((user) => user.removal) ? await this.deps.machines() : [];
    return Promise.all(users.map(async (user) => {
      const instance = instances.find((entry) => entry.ownerId === user.id);
      const removing = async (removal: NonNullable<UserMetadata['removal']>) => {
        const state = await this.deps.workflows.state(removeAccountWorkflowId(user.id));
        return { ...removal, state, ...(steps ? { steps } : {}), ...(await this.koalaOf(user.id, state, instances, watches, machines)) };
      };
      return {
        id: user.id,
        email: user.email,
        operator: this.operator(user),
        createdAt: user.createdAt,
        ...(instance ? { instance: instanceOf(instance, releases, watches.find((watch) => watch.instanceId === instance.id), logouts, this.deps.currentRelease) } : {}),
        ...(user.removal ? { removal: await removing(user.removal) } : {}),
      };
    }));
  }
}
