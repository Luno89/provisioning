import type { ClusterMetadata, DeploymentMetadata, UserMetadata } from './types.js';
import { adoptionWorkflowId, benchIdleId, concludeWorkspaceId, conversationConclusionId, groveRunWorkflowId } from '../engine-host/temporal/contracts.js';
import { conversationWatermarkKey, memoryRunId } from './conclusions.js';

export const removeAccountWorkflowId = (ownerId: string): string => `remove-account-${ownerId}`;
export const REMOVE_ACCOUNT_WORKFLOW = 'RemoveAccountWorkflow';
export const REMOVAL_PROGRESS_QUERY = 'removalProgress';

export type RemovalStep = 'workflows' | 'workspaces' | 'secrets' | 'mesh' | 'repositories' | 'records';
export const REMOVAL_STEPS: readonly RemovalStep[] = ['workflows', 'workspaces', 'secrets', 'mesh', 'repositories', 'records'];

export const ACTIVITY_STOP_GRACE_MS = 30_000;

export interface RemovalRequest {
  ownerId: string;
  requestedBy: string;
  confirm: string;
}

export interface RemovalWorld {
  users: readonly Pick<UserMetadata, 'id' | 'email' | 'isAdmin'>[];
  clusters: readonly Pick<ClusterMetadata, 'id' | 'name' | 'status' | 'ownerId'>[];
  deployments: readonly Pick<DeploymentMetadata, 'id' | 'name' | 'ownerId'>[];
}

export type RemovalRefusal =
  | { status: 404; error: string }
  | { status: 403; error: string }
  | { status: 400; error: string }
  | { status: 409; error: string; blockers: string[] };

const GONE: ClusterMetadata['status'][] = ['destroyed'];

export function removalBlockers(ownerId: string, world: RemovalWorld): string[] {
  const target = world.users.find((user) => user.id === ownerId);
  const blockers: string[] = [];
  if (target?.isAdmin && !world.users.some((user) => user.id !== ownerId && user.isAdmin)) {
    blockers.push('this is the only admin account; make someone else an admin first');
  }
  for (const cluster of world.clusters.filter((entry) => entry.ownerId === ownerId && !GONE.includes(entry.status))) {
    blockers.push(`the cluster "${cluster.name}" is still ${cluster.status}; destroy it first`);
  }
  for (const deployment of world.deployments.filter((entry) => entry.ownerId === ownerId)) {
    blockers.push(`the app "${deployment.name}" is still deployed; remove it first`);
  }
  return blockers;
}

export function refuseRemoval(request: RemovalRequest, world: RemovalWorld & { requester?: Pick<UserMetadata, 'id' | 'isAdmin'> | undefined }): RemovalRefusal | undefined {
  const target = world.users.find((user) => user.id === request.ownerId);
  if (!target) return { status: 404, error: 'There is no such account' };
  if (request.requestedBy !== request.ownerId && !world.requester?.isAdmin) return { status: 403, error: 'Only an admin can remove someone else\'s account' };
  if (request.confirm.trim().toLowerCase() !== target.email.toLowerCase()) return { status: 400, error: `Type the account's email, ${target.email}, to confirm` };
  const blockers = removalBlockers(request.ownerId, world);
  if (blockers.length > 0) return { status: 409, error: 'The account cannot be removed yet', blockers };
  return undefined;
}

export interface OwnedIds {
  runIds: readonly string[];
  treeIds: readonly string[];
  conversationIds: readonly string[];
  proposalIds: readonly string[];
}

export function ownedWorkflowIds(ownerId: string, owned: OwnedIds): string[] {
  return [...new Set([
    benchIdleId(ownerId),
    ...owned.runIds,
    ...owned.runIds.map(memoryRunId),
    ...owned.treeIds.flatMap((id) => [groveRunWorkflowId(id), concludeWorkspaceId({ kind: 'tree', id })]),
    ...owned.conversationIds.flatMap((id) => [conversationConclusionId(id), concludeWorkspaceId({ kind: 'conversation', id })]),
    ...owned.proposalIds.map(adoptionWorkflowId),
  ])];
}

export const memoryWatermarkKeys = (owned: Pick<OwnedIds, 'conversationIds'>): string[] =>
  owned.conversationIds.map(conversationWatermarkKey);

export interface RemovalProgress {
  ownerId: string;
  email: string;
  startedAt: string;
  requestedBy: string;
  done: RemovalStep[];
  removed?: Record<string, number> | undefined;
}

export const ACCOUNT_DATA = {
  byOwner: [
    'accessRequests', 'actionProposals', 'appSpecs', 'artifactChunks', 'artifacts', 'authoredExtensions', 'bindingTypes', 'branches', 'clusters', 'conversations',
    'corpus', 'deployments', 'egressGrants', 'egressRequests', 'enginePersonas', 'engineRunEffort', 'engineRunTraces', 'engineTools',
    'evalAgentChanges', 'evalCases', 'evalLevel1Runs', 'evalPrompts', 'evalRuns', 'evalScenarioProposals', 'evalScenarioRuns',
    'evalScenarios', 'instanceJoinTokens', 'instances', 'leaves', 'localAgentDevices', 'mcpRequests', 'mcpToolHints', 'memories',
    'modelEndpoints', 'odooReleases', 'pendingApprovals', 'planProposals', 'procedures', 'projects', 'secretRequests', 'tasks', 'treeTypes', 'trees',
    'scriptedRequests', 'turnLogs', 'workspaceImages',
  ],
  byId: ['benchSettings', 'benchStates', 'extensionSettings', 'giteaAccounts'],
  related: { memoryWatermarks: 'the keys of its conversations', crawl_frontier: 'its ingests', pipelineRuns: 'its projects' },
  last: 'users',
  shared: ['clusterProviders', 'identityHandoffs', 'invites', 'model_thinking_profiles', 'temporal_payload_chunks'],
} as const;

export interface AccountRelated {
  watermarkKeys: readonly string[];
  ingestIds: readonly string[];
  projectIds: readonly string[];
}
