import { Context } from '@temporalio/activity';
import type { AccountIds } from '../lib/db-interface.js';
import { memoryWatermarkKeys, ownedWorkflowIds, type AccountRelated } from '../lib/account-removal.js';
import type { KubeRunner } from '../engine-host/sandboxes/kube.js';
import { labelValue } from '../engine-host/sandboxes/workspace.js';

export interface RemoveAccountArgs {
  ownerId: string;
  keepRunsFor?: string | undefined;
}

export interface AccountRemovalDeps {
  store: {
    accountIds(ownerId: string): Promise<AccountIds>;
    removeAccountRecords(ownerId: string, related: AccountRelated): Promise<Record<string, number>>;
    getGiteaAccount(ownerId: string): Promise<{ username: string } | null>;
    reownRuns(from: string, to: string): Promise<number>;
  };
  workflows: { stopIfRunning(workflowId: string, reason: string): Promise<boolean> };
  kube: KubeRunner;
  repositories: { deleteUser(username: string): Promise<boolean> };
  mesh: { removeUser(ownerId: string): Promise<{ devices: number; user: boolean }> };
  secrets: { removeProject(projectId: string): Promise<{ workspace: boolean; readers: number }> };
}

export interface AccountRemovalActivities {
  RemoveAccountWorkflowsActivity(args: RemoveAccountArgs): Promise<number>;
  RemoveAccountKeepRunsActivity(args: { ownerId: string; keepRunsFor: string }): Promise<number>;
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
  return {
    async RemoveAccountWorkflowsActivity({ ownerId }) {
      const ids = ownedWorkflowIds(ownerId, await deps.store.accountIds(ownerId));
      let stopped = 0;
      for (let at = 0; at < ids.length; at += BATCH) {
        const results = await Promise.all(ids.slice(at, at + BATCH).map((id) => deps.workflows.stopIfRunning(id, REASON)));
        stopped += results.filter(Boolean).length;
        heartbeat();
      }
      return stopped;
    },

    async RemoveAccountKeepRunsActivity({ ownerId, keepRunsFor }) {
      return deps.store.reownRuns(ownerId, keepRunsFor);
    },

    async RemoveAccountWorkspacesActivity({ ownerId }) {
      const result = await deps.kube(['delete', 'namespace', '-l', `koala.dev/owner=${labelValue(ownerId)}`, '--wait=true', '--timeout=300s'], undefined, 330_000);
      if (result.exitCode !== 0 && !/no resources found/i.test(`${result.stdout}${result.stderr}`)) {
        throw new Error(`the account's workspaces could not be deleted: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return result.stdout.trim();
    },

    async RemoveAccountSecretsActivity({ ownerId }) {
      const { projectIds } = await deps.store.accountIds(ownerId);
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
      const account = await deps.store.getGiteaAccount(ownerId);
      if (!account) return false;
      return deps.repositories.deleteUser(account.username);
    },

    async RemoveAccountRecordsActivity({ ownerId }) {
      const ids = await deps.store.accountIds(ownerId);
      return deps.store.removeAccountRecords(ownerId, {
        watermarkKeys: memoryWatermarkKeys(ids),
        ingestIds: ids.ingestIds,
        projectIds: ids.projectIds,
      });
    },
  };
}
