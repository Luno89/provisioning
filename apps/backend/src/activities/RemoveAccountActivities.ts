import { Context } from '@temporalio/activity';
import { memoryWatermarkKeys, ownedWorkflowIds, type AccountIds, type AccountRelated } from '../accounts/index.js';
import type { KubeRunner } from '../engine-host/sandboxes/kube.js';
import { labelValue } from '../engine-host/sandboxes/workspace.js';
import { type Closing, type DeploymentMetadata, type RoleConfig, type UserMetadata, CLI_CEILING, holdsAccounts } from '../platform/index.js';
import { endFenceOf, raiseAndHold, type FenceRecords } from './fence-steps.js';
import { planAppDestroys, type AppTeardown, type AppToDestroy } from './RemoveProjectActivities.js';

export interface RemoveAccountArgs {
  ownerId: string;
  keepRunsFor?: string | undefined;
}

export interface AccountRemovalDeps {
  store: {
    platform: FenceRecords;
    accounts: {
      getUserById(id: string): Promise<UserMetadata | undefined>;
      saveUser(user: UserMetadata): Promise<void>;
      accountIds(ownerId: string): Promise<AccountIds>;
      removeAccountRecords(ownerId: string, related: AccountRelated): Promise<Record<string, number>>;
    };
    projects: {
      getGiteaAccount(ownerId: string): Promise<{ username: string } | null>;
    };
    engine: {
      reownRuns(from: string, to: string): Promise<number>;
    };
    files: {
      reownRunFiles(from: string, to: string): Promise<number>;
    };
    infrastructure: {
      getDeployments(): Promise<DeploymentMetadata[]>;
      saveDeploymentInfo(deployment: Partial<DeploymentMetadata> & { id: string }): Promise<DeploymentMetadata>;
    };
  };
  apps: AppTeardown;
  workflows: { stopIfRunning(workflowId: string, reason: string): Promise<boolean> };
  kube: KubeRunner;
  repositories: { deleteUser(username: string): Promise<boolean> };
  mesh: { removeUser(ownerId: string): Promise<{ devices: number; user: boolean }> };
  secrets: { removeProject(projectId: string): Promise<{ workspace: boolean; readers: number }> };
  files: { removeOwned(ownerId: string): Promise<number> };
  now?: () => number;
}

export type RemovalMesh = AccountRemovalDeps['mesh'];

export const NO_MESH_HERE: RemovalMesh = { removeUser: async () => ({ devices: 0, user: false }) };

export const removalMeshFor = (role: RoleConfig, headscale: () => RemovalMesh): RemovalMesh =>
  holdsAccounts(role) ? headscale() : NO_MESH_HERE;

export interface AccountRemovalActivities {
  RemoveAccountFenceActivity(args: RemoveAccountArgs): Promise<string[]>;
  RemoveAccountFenceEndActivity(args: RemoveAccountArgs): Promise<Closing[]>;
  RemoveAccountWorkflowsActivity(args: RemoveAccountArgs): Promise<number>;
  RemoveAccountKeepRunsActivity(args: { ownerId: string; keepRunsFor: string }): Promise<number>;
  RemoveAccountAppsActivity(args: RemoveAccountArgs): Promise<AppToDestroy[]>;
  RemoveAccountAppStartedActivity(args: { deploymentId: string; workflowId: string }): Promise<void>;
  RemoveAccountWorkspacesActivity(args: RemoveAccountArgs): Promise<string>;
  RemoveAccountSecretsActivity(args: RemoveAccountArgs): Promise<number>;
  RemoveAccountMeshActivity(args: RemoveAccountArgs): Promise<{ devices: number; user: boolean }>;
  RemoveAccountRepositoriesActivity(args: RemoveAccountArgs): Promise<boolean>;
  RemoveAccountRecordsActivity(args: RemoveAccountArgs): Promise<Record<string, number>>;
}

const REASON = 'the account was removed';
const BATCH = 20;

const heartbeat = () => {
  try {
    Context.current().heartbeat();
  } catch {
    return;
  }
};

export function createAccountRemovalActivities(deps: AccountRemovalDeps): AccountRemovalActivities {
  const now = deps.now ?? Date.now;
  return {
    async RemoveAccountFenceActivity({ ownerId, keepRunsFor }) {
      const at = new Date(now()).toISOString();
      const user = await deps.store.accounts.getUserById(ownerId);
      if (user && !user.removal) await deps.store.accounts.saveUser({ ...user, removal: { startedAt: at, requestedBy: keepRunsFor ?? ownerId } });
      return raiseAndHold(deps.store.platform, { kind: 'owner', id: ownerId }, now);
    },

    async RemoveAccountFenceEndActivity({ ownerId }) {
      return endFenceOf(deps.store.platform, { kind: 'owner', id: ownerId }, now);
    },

    async RemoveAccountWorkflowsActivity({ ownerId }) {
      const ids = ownedWorkflowIds(ownerId, await deps.store.accounts.accountIds(ownerId));
      let stopped = 0;
      for (let at = 0; at < ids.length; at += BATCH) {
        const results = await Promise.all(ids.slice(at, at + BATCH).map((id) => deps.workflows.stopIfRunning(id, REASON)));
        stopped += results.filter(Boolean).length;
        heartbeat();
      }
      return stopped;
    },

    async RemoveAccountKeepRunsActivity({ ownerId, keepRunsFor }) {
      return (await deps.store.engine.reownRuns(ownerId, keepRunsFor)) + (await deps.store.files.reownRunFiles(ownerId, keepRunsFor));
    },

    async RemoveAccountAppsActivity({ ownerId }) {
      const deployments = await deps.store.infrastructure.getDeployments();
      const owned = deployments.filter((deployment) => deployment.ownerId === ownerId).map((deployment) => deployment.id);
      if (owned.length === 0) return [];
      const planned = await planAppDestroys(deployments, owned, deps.apps, () => Math.random().toString(36).slice(2, 8));
      for (const app of planned) await deps.store.infrastructure.saveDeploymentInfo({ id: app.deploymentId, status: 'destroying', temporalWorkflowId: '', lastLogPath: app.args.logFile });
      return planned;
    },

    async RemoveAccountAppStartedActivity({ deploymentId, workflowId }) {
      await deps.store.infrastructure.saveDeploymentInfo({ id: deploymentId, temporalWorkflowId: workflowId });
    },

    async RemoveAccountWorkspacesActivity({ ownerId }) {
      const result = await deps.kube(['delete', 'namespace', '-l', `koala.dev/owner=${labelValue(ownerId)}`, '--wait=true', `--timeout=${CLI_CEILING}`]);
      if (result.exitCode !== 0 && !/no resources found/i.test(`${result.stdout}${result.stderr}`)) {
        throw new Error(`the account's workspaces could not be deleted: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return result.stdout.trim();
    },

    async RemoveAccountSecretsActivity({ ownerId }) {
      const { projectIds } = await deps.store.accounts.accountIds(ownerId);
      let removed = 0;
      for (const projectId of projectIds) {
        const gone = await deps.secrets.removeProject(projectId);
        removed += (gone.workspace ? 1 : 0) + gone.readers;
        heartbeat();
      }
      return removed;
    },

    async RemoveAccountMeshActivity({ ownerId }) {
      return deps.mesh.removeUser(ownerId);
    },

    async RemoveAccountRepositoriesActivity({ ownerId }) {
      const account = await deps.store.projects.getGiteaAccount(ownerId);
      if (!account) return false;
      return deps.repositories.deleteUser(account.username);
    },

    async RemoveAccountRecordsActivity({ ownerId }) {
      const files = await deps.files.removeOwned(ownerId);
      const ids = await deps.store.accounts.accountIds(ownerId);
      const removed = await deps.store.accounts.removeAccountRecords(ownerId, {
        watermarkKeys: memoryWatermarkKeys(ids),
        ingestIds: ids.ingestIds,
        projectIds: ids.projectIds,
      });
      return files > 0 ? { ...removed, storedFiles: (removed.storedFiles ?? 0) + files } : removed;
    },
  };
}
