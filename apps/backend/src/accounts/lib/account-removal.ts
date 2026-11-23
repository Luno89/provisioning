import type { ClusterMetadata, DeploymentMetadata, UserMetadata } from '../../platform/index.js';
import { authorize, type Principal } from '../../platform/lib/permissions.js';
import { ownedQuery } from '../../platform/lib/workflow-owner.js';
import { conversationWatermarkKey } from '../../memory/lib/conclusions.js';
import type { DeletionProgress } from '../../projects/index.js';

export const removeAccountWorkflowId = (ownerId: string): string => `remove-account-${ownerId}`;
export const DELETE_ACCOUNT_WORKFLOW = 'DeleteAccountWorkflow';
export const REMOVAL_PROGRESS_QUERY = 'removalProgress';

export const OWNER_REMOVING = 'owner:removing';
export const KOALA_REMOVAL_SIGNAL = 'koala-removal';
export const KOALA_REMOVAL_QUERY = 'koalaRemoval';
export const MACHINE_UNINSTALLED_SIGNAL = 'machine-uninstalled';
export const MACHINE_REMOVALS_QUERY = 'machineRemovals';

export interface MachineUninstalled {
  id: string;
  problem?: string | undefined;
}

export interface MachineRemoval {
  id: string;
  name: string;
  state: 'uninstalling' | 'uninstalled';
}

export interface AccountDeletionChange {
  ownerId: string;
  progress: DeletionProgress;
}

export type RemovalStep = 'workflows' | 'projects' | 'apps' | 'workspaces' | 'secrets' | 'mesh' | 'repositories' | 'records' | 'instance' | 'koala' | 'machines';
export const ROOT_REMOVAL_WORKFLOW = 'RootAccountRemovalWorkflow';
export const ROOT_REMOVAL_STEPS: readonly RemovalStep[] = ['instance', 'koala', 'machines', 'mesh', 'records'];

const bare = (id: string): string => id.replace(/["\\]/g, '');

export const openAccountWork = (ownerId: string): string =>
  `${ownedQuery(ownerId)} AND ExecutionStatus = "Running" AND WorkflowId != "${removeAccountWorkflowId(bare(ownerId))}"`;

export interface RemovalRequest {
  ownerId: string;
  requestedBy: string;
  confirm: string;
}

export interface RemovalWorld {
  users: readonly (Pick<UserMetadata, 'id' | 'email'> & { operator: boolean })[];
  clusters: readonly Pick<ClusterMetadata, 'id' | 'name' | 'status' | 'ownerId'>[];
  deployments: readonly Pick<DeploymentMetadata, 'id' | 'name' | 'ownerId'>[];
}

export type RemovalRefusal =
  | { status: 404; error: string }
  | { status: 403; error: string }
  | { status: 400; error: string }
  | { status: 429; error: string }
  | { status: 409; error: string; blockers: string[] };

const GONE: ClusterMetadata['status'][] = ['destroyed'];

export function removalBlockers(ownerId: string, world: RemovalWorld): string[] {
  const target = world.users.find((user) => user.id === ownerId);
  const blockers: string[] = [];
  if (target?.operator && !world.users.some((user) => user.id !== ownerId && user.operator)) {
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

export function refuseRemoval(request: RemovalRequest, world: RemovalWorld & { requester: Principal }): RemovalRefusal | undefined {
  const target = world.users.find((user) => user.id === request.ownerId);
  if (!target) return { status: 404, error: 'There is no such account' };
  const removing = authorize(world.requester, 'remove', { kind: 'account', id: request.ownerId });
  if (!removing.allowed) return { status: 403, error: removing.error };
  if (request.confirm.trim().toLowerCase() !== target.email.toLowerCase()) return { status: 400, error: `Type the account's email, ${target.email}, to confirm` };
  const blockers = removalBlockers(request.ownerId, world);
  if (blockers.length > 0) return { status: 409, error: 'The account cannot be removed yet', blockers };
  return undefined;
}

export const memoryWatermarkKeys = (owned: { conversationIds: readonly string[] }): string[] =>
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
    'corpus', 'deferredConclusions', 'deployments', 'egressGrants', 'egressRequests', 'enginePersonas', 'engineRunEffort', 'engineRunTraces', 'engineTools',
    'evalAgentChanges', 'evalCases', 'evalLevel1Runs', 'evalPrompts', 'evalRuns', 'evalScenarioProposals', 'evalScenarioRuns',
    'evalScenarios', 'fileShares', 'giteaTokensToRevoke', 'hubLinks', 'instanceWatches', 'instances', 'leaves', 'localAgentDevices', 'machineJoinCodes', 'mcpRequests',
    'mcpServers', 'mcpToolHints', 'memories', 'modelEndpoints', 'monitoringAlertEpisodes', 'monitoringAlertRules', 'monitoringSettings', 'odooReleases', 'passwordResets', 'pendingApprovals', 'planProposals',
    'procedures', 'projects', 'provisioning', 'publishedWorkspaces', 'pushSubscriptions', 'poisoningSignals', 'releaseWithdrawalNotices', 'rememberedBrowsers', 'runEndings', 'runGrants', 'runReads', 'secretRequests', 'serverOrders', 'tasks', 'toolGrants', 'trees', 'treeTypes', 'twoFactorCodes', 'workFailures',
    'scriptedRequests', 'storedFiles', 'turnLogs', 'workspaceDependencies', 'workspaceImages',
  ],
  byId: ['autoModeSettings', 'benchSettings', 'benchStates', 'extensionSettings', 'giteaAccounts', 'keeperSettings', 'memoryKeeping', 'notificationSettings'],
  related: { memoryWatermarks: 'the keys of its conversations', pipelineRuns: 'its projects', oidcArtifacts: 'its sign-in grants, sessions and tokens at root' },
  last: 'users',
  shared: ['dependencyChecks', 'dependencyFindings', 'dependencyStates', 'instanceReleases', 'inviteLimits', 'invites', 'logoutDeliveries', 'migrations', 'model_thinking_profiles', 'pendingSignUps', 'signInAttempts', 'temporal_payload_chunks', 'toolCallParsers'],
} as const;

type AccountData = typeof ACCOUNT_DATA;

export type AccountCollection = AccountData['byOwner' | 'byId' | 'shared'][number] | keyof AccountData['related'] | AccountData['last'];

export interface AccountIds {
  runIds: string[];
  treeIds: string[];
  conversationIds: string[];
  proposalIds: string[];
  projectIds: string[];
  buildWorkflowIds: string[];
}

export interface AccountRelated {
  watermarkKeys: readonly string[];
  projectIds: readonly string[];
}
