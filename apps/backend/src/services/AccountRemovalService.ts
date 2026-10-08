import type { ClusterMetadata, DeploymentMetadata, UserMetadata } from '../lib/types.js';
import type { Client } from '@temporalio/client';
import { startedFor } from '../lib/workflow-owner.js';
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
  client: () => Client | undefined | null,
  taskQueue: string,
  progressQuery: string = REMOVAL_PROGRESS_QUERY,
): AccountRemovalWorkflows<Args, Step> {
  return {
    async start(workflowType, workflowId, args, owner) {
      const temporal = client();
      if (!temporal) throw new Error('Temporal is not reachable, so the account cannot be removed now');
      await temporal.workflow.start(workflowType, { workflowId, taskQueue, args, ...startedFor(owner) });
    },
    async state(workflowId) {
      const temporal = client();
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
  now?: () => string;
}

export interface PersonEntry {
  id: string;
  email: string;
  isAdmin: boolean;
  createdAt: string;
  removal?: { startedAt: string; requestedBy: string; state: RemovalWorkflowState } | undefined;
}

export class AccountRemovalService {
  constructor(private readonly deps: AccountRemovalDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async world() {
    const [users, clusters, deployments] = await Promise.all([this.deps.store.getUsers(), this.deps.store.getClusters(), this.deps.store.getDeployments()]);
    return { users, clusters, deployments };
  }

  async preview(ownerId: string): Promise<{ email: string; blockers: string[] } | undefined> {
    const world = await this.world();
    const user = world.users.find((entry) => entry.id === ownerId);
    return user ? { email: user.email, blockers: removalBlockers(ownerId, world) } : undefined;
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
    await this.deps.store.saveUser({ ...target!, removal: { startedAt: this.now(), requestedBy: request.requestedBy } });
    await this.deps.workflows.start(REMOVE_ACCOUNT_WORKFLOW, workflowId, [{ ownerId: request.ownerId }], request.ownerId);
    return { ok: true, state: await this.deps.workflows.state(workflowId) };
  }

  async people(): Promise<PersonEntry[]> {
    const users = (await this.deps.store.getUsers()).filter((user) => !user.space);
    return Promise.all(users.map(async (user) => ({
      id: user.id,
      email: user.email,
      isAdmin: user.isAdmin === true,
      createdAt: user.createdAt,
      ...(user.removal ? { removal: { ...user.removal, state: await this.deps.workflows.state(removeAccountWorkflowId(user.id)) } } : {}),
    })));
  }
}
