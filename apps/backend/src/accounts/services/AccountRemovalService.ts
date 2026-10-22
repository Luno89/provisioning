import type { ClusterMetadata, DeploymentMetadata, UserMetadata } from '../../platform/lib/types.js';
import type { InstanceRecord, InstanceStatus } from '../../instances/lib/instances.js';
import type { Client } from '@temporalio/client';
import type { HubPeople } from '../../hub/services/HubPeople.js';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import {
  REMOVAL_PROGRESS_QUERY,
  REMOVE_ACCOUNT_WORKFLOW,
  refuseRemoval,
  removalBlockers,
  removeAccountWorkflowId,
  type RemovalRefusal,
  type RemovalRequest,
  type RemovalStep,
} from '../lib/account-removal.js';

export interface AccountRemovalStore {
  getUsers(): Promise<UserMetadata[]>;
  getUserById(id: string): Promise<UserMetadata | undefined>;
  saveUser(user: UserMetadata): Promise<void>;
  getClusters(): Promise<ClusterMetadata[]>;
  getDeployments(): Promise<DeploymentMetadata[]>;
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
      if (described.status.name === 'RUNNING') return { state: 'running', done: await handle.query<Step[]>(progressQuery).catch(() => []) };
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
  hub?: HubPeople | undefined;
  now?: () => string;
}

export interface PersonInstance {
  name?: string | undefined;
  where: 'pool' | 'own';
  status: InstanceStatus;
  detail?: string | undefined;
  url: string;
  trialEndsAt?: string | undefined;
}

export interface PersonEntry {
  id: string;
  email: string;
  isAdmin: boolean;
  createdAt: string;
  instance?: PersonInstance | undefined;
  removal?: { startedAt: string; requestedBy: string; state: RemovalWorkflowState; steps?: readonly RemovalStep[] | undefined } | undefined;
}

const instanceOf = (instance: InstanceRecord): PersonInstance => ({
  ...(instance.name ? { name: instance.name } : {}),
  where: instance.pool ? 'pool' : 'own',
  status: instance.status ?? (instance.url ? 'ready' : 'waiting'),
  ...(instance.detail ? { detail: instance.detail } : {}),
  url: instance.url,
  ...(instance.pool ? { trialEndsAt: instance.pool.trialEndsAt } : {}),
});

export class AccountRemovalService {
  constructor(private readonly deps: AccountRemovalDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async world() {
    const [users, clusters, deployments] = await Promise.all([this.deps.store.getUsers(), this.deps.store.getClusters(), this.deps.store.getDeployments()]);
    return { users, clusters, deployments };
  }

  async preview(ownerId: string): Promise<{ email: string; blockers: string[]; instance?: PersonInstance } | undefined> {
    const world = await this.world();
    const user = world.users.find((entry) => entry.id === ownerId);
    if (!user) return undefined;
    const instance = this.deps.instances ? (await this.deps.instances()).find((entry) => entry.ownerId === ownerId) : undefined;
    const blockers = [...removalBlockers(ownerId, world), ...(this.deps.hub ? await this.deps.hub.blockers(ownerId) : [])];
    return { email: user.email, blockers, ...(instance ? { instance: instanceOf(instance) } : {}) };
  }

  async remove(request: RemovalRequest): Promise<{ ok: true; state: RemovalWorkflowState } | { ok: false; refusal: RemovalRefusal }> {
    const world = await this.world();
    const requester = world.users.find((entry) => entry.id === request.requestedBy);
    const target = world.users.find((entry) => entry.id === request.ownerId);
    const refusal = refuseRemoval(request, { ...world, requester });
    if (refusal) return { ok: false, refusal };

    const workflowId = removeAccountWorkflowId(request.ownerId);
    const current = await this.deps.workflows.state(workflowId);
    if (current.state === 'running') return { ok: true, state: current };
    if (this.deps.hub) {
      const blockers = await this.deps.hub.blockers(request.ownerId);
      if (blockers.length > 0) return { ok: false, refusal: { status: 409, error: 'The account cannot be removed yet', blockers } };
      await this.deps.hub.letGo(request.ownerId);
    }
    await this.deps.store.saveUser({ ...target!, removal: { startedAt: this.now(), requestedBy: request.requestedBy } });
    await this.deps.workflows.start(this.deps.workflowType ?? REMOVE_ACCOUNT_WORKFLOW, workflowId, [{ ownerId: request.ownerId }], request.ownerId);
    return { ok: true, state: await this.deps.workflows.state(workflowId) };
  }

  async people(): Promise<PersonEntry[]> {
    const users = (await this.deps.store.getUsers()).filter((user) => !user.space);
    const instances = this.deps.instances ? await this.deps.instances() : [];
    const steps = this.deps.steps;
    return Promise.all(users.map(async (user) => {
      const instance = instances.find((entry) => entry.ownerId === user.id);
      return {
        id: user.id,
        email: user.email,
        isAdmin: user.isAdmin === true,
        createdAt: user.createdAt,
        ...(instance ? { instance: instanceOf(instance) } : {}),
        ...(user.removal ? { removal: { ...user.removal, state: await this.deps.workflows.state(removeAccountWorkflowId(user.id)), ...(steps ? { steps } : {}) } } : {}),
      };
    }));
  }
}
