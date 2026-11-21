import { ignore } from '@koala/engine-core/failures';
import type { Client } from '@temporalio/client';
import { cancelIfRunning, frozenWorkersIn, projectQuery, type CancellableWorkflow, type HistoryEvent } from '../platform/index.js';
import type { ProjectRemovalActivities, RemoveProjectArgs } from './RemoveProjectActivities.js';

export interface ProjectWork {
  open(query: string): Promise<string[]>;
  handle(workflowId: string): CancellableWorkflow & { history(): Promise<readonly HistoryEvent[]> };
}

export type ProjectRemovalSteps = Pick<ProjectRemovalActivities, 'RemoveProjectAppsActivity' | 'RemoveProjectAppStartedActivity' | 'RemoveProjectWorkspacesActivity' | 'RemoveProjectSecretsActivity' | 'RemoveProjectRepositoriesActivity' | 'RemoveProjectFilesActivity' | 'RemoveProjectRecordsActivity'>;

export interface ProjectDeletionDeps {
  work: ProjectWork;
  removal: ProjectRemovalSteps;
}

export interface FrozenWorkDeps {
  work: ProjectWork;
  workers: { restart(identity: string): Promise<'restarted' | 'not-here'> };
}

export interface SweepPass {
  open: string[];
  apps: number;
  deleted: number;
}

export interface FrozenWorkActivities {
  AwaitProjectWorkActivity(args: { workflowIds: string[] }): Promise<{ restarted: string[] }>;
}

export interface ProjectDeletionActivities extends ProjectRemovalSteps {
  StopProjectWorkActivity(args: RemoveProjectArgs): Promise<string[]>;
  SweepProjectActivity(args: RemoveProjectArgs): Promise<SweepPass>;
}

const openWork = (projectId: string): string => `${projectQuery(projectId)} AND ExecutionStatus = "Running"`;

const cancelOpen = async (work: ProjectWork, projectId: string): Promise<string[]> => {
  const ids = await work.open(openWork(projectId));
  const sent = await Promise.all(ids.map(async (id) => ((await cancelIfRunning(work.handle(id))) === 'cancelled' ? id : undefined)));
  return sent.filter((id): id is string => id !== undefined);
};

export function createFrozenWorkActivities(deps: FrozenWorkDeps): FrozenWorkActivities {
  return {
    async AwaitProjectWorkActivity({ workflowIds }) {
      const frozen = new Set<string>();
      for (const id of workflowIds) {
        const handle = deps.work.handle(id);
        await handle.result().catch(ignore('a workflow that ends cancelled or failed rejects its result, which is it closing all the same'));
        for (const worker of frozenWorkersIn(await handle.history())) frozen.add(worker);
      }
      const restarted: string[] = [];
      for (const worker of frozen) if ((await deps.workers.restart(worker)) === 'restarted') restarted.push(worker);
      return { restarted };
    },
  };
}

export const temporalProjectWork = (client: () => Promise<Client>): ProjectWork => ({
  async open(query) {
    const ids: string[] = [];
    for await (const execution of (await client()).workflow.list({ query })) ids.push(execution.workflowId);
    return ids;
  },
  handle(workflowId) {
    const handle = async () => (await client()).workflow.getHandle(workflowId);
    return {
      describe: async () => (await handle()).describe(),
      cancel: async () => (await handle()).cancel(),
      result: async () => {
        const ended: unknown = await (await handle()).result();
        return ended;
      },
      history: async () => ((await (await handle()).fetchHistory()).events ?? []) as readonly HistoryEvent[],
    };
  },
});

export function createProjectDeletionActivities(deps: ProjectDeletionDeps): ProjectDeletionActivities {
  return {
    ...deps.removal,

    StopProjectWorkActivity: ({ projectId }) => cancelOpen(deps.work, projectId),

    async SweepProjectActivity(args) {
      const open = await cancelOpen(deps.work, args.projectId);
      const apps = (await deps.removal.RemoveProjectAppsActivity(args)).length;
      const workspaces = await deps.removal.RemoveProjectWorkspacesActivity(args);
      const secrets = await deps.removal.RemoveProjectSecretsActivity(args);
      return { open, apps, deleted: workspaces + (secrets.workspace ? 1 : 0) + secrets.readers };
    },
  };
}
