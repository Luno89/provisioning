import { ignore } from '@koala/engine-core/failures';
import type { Client } from '@temporalio/client';
import { withWorkFor } from '@koala/engine-core/work-for';
import { Context } from '@temporalio/activity';
import { cancelIfRunning, cancelledDetailsIn, DEPENDENCIES, DependencyDownError, frozenWorkersIn, killedIn, projectQuery, startedFor, type CancellableWorkflow, type CancelPayload, type HistoryEvent } from '../platform/index.js';
import { PURGE_PROJECT_WORKFLOW, SERVICE_BACK_SIGNAL, SERVICE_DOWN_SIGNAL, keptUntil, purgeStart, type OpenWork, type ProjectsStore, type ServiceDown } from '../projects/index.js';
import type { ProjectRemovalActivities, RemoveProjectArgs } from './RemoveProjectActivities.js';
import type { ProjectDeletionMode } from '../platform/index.js';

export interface DeleteProjectArgs extends RemoveProjectArgs {
  mode: ProjectDeletionMode;
}

type Decodable = Parameters<Client['options']['loadedDataConverter']['payloadCodecs'][number]['decode']>[0];

export interface ProjectWork {
  open(query: string): Promise<OpenWork[]>;
  handle(workflowId: string): CancellableWorkflow & { history(): Promise<readonly HistoryEvent[]> };
  decode(payloads: readonly CancelPayload[]): Promise<unknown[]>;
}

export type ProjectRemovalSteps = Pick<ProjectRemovalActivities, 'RemoveProjectAppsActivity' | 'RemoveProjectAppStartedActivity' | 'RemoveProjectWebhookActivity' | 'RemoveProjectWorkspacesActivity' | 'RemoveProjectSecretsActivity' | 'RemoveProjectRepositoriesActivity' | 'RemoveProjectFilesActivity' | 'RemoveProjectRecordsActivity'>;

export interface ProjectArchive {
  archive(projectId: string): Promise<boolean>;
  keep(projectId: string): Promise<{ keptUntil: string }>;
}

export interface ProjectDeletionDeps {
  work: ProjectWork;
  removal: ProjectRemovalSteps;
  archive: ProjectArchive;
  told: DeletionTold;
}

export interface FrozenWorkDeps {
  work: ProjectWork;
  workers: { restart(identity: string): Promise<'restarted' | 'not-here'> };
}

export interface SweepPass {
  open: OpenWork[];
  apps: number;
  workspaces: number;
  secrets: number;
}

export interface FrozenWorkActivities {
  AwaitProjectWorkActivity(args: { workflowId: string }): Promise<{ frozen: string[]; killed: string[] }>;
  RestartWorkerActivity(args: { worker: string }): Promise<'restarted' | 'not-here'>;
}

export interface ProjectDeletionActivities extends ProjectRemovalSteps {
  StopProjectWorkActivity(args: RemoveProjectArgs): Promise<OpenWork[]>;
  SweepProjectActivity(args: RemoveProjectArgs): Promise<SweepPass>;
  ArchiveProjectActivity(args: RemoveProjectArgs): Promise<{ keptUntil: string }>;
}

const openWork = (projectId: string): string => `${projectQuery(projectId)} AND ExecutionStatus = "Running"`;

const cancelOpen = async (work: ProjectWork, projectId: string): Promise<OpenWork[]> => {
  const open = await work.open(openWork(projectId));
  const sent = await Promise.all(open.map(async (found) => ((await cancelIfRunning(work.handle(found.workflowId))) === 'cancelled' ? found : undefined)));
  return sent.filter((found): found is OpenWork => found !== undefined);
};

export function createFrozenWorkActivities(deps: FrozenWorkDeps): FrozenWorkActivities {
  return {
    async AwaitProjectWorkActivity({ workflowId }) {
      const handle = deps.work.handle(workflowId);
      await handle.result().catch(ignore('a workflow that ends cancelled or failed rejects its result, which is it closing all the same'));
      const events = await handle.history();
      const details = await Promise.all(cancelledDetailsIn(events).map((payloads) => deps.work.decode(payloads)));
      return { frozen: frozenWorkersIn(events), killed: killedIn(details.flat()) };
    },
    RestartWorkerActivity: ({ worker }) => deps.workers.restart(worker),
  };
}

export const temporalProjectWork = (client: () => Promise<Client>): ProjectWork => ({
  async open(query) {
    const found: OpenWork[] = [];
    for await (const execution of (await client()).workflow.list({ query })) {
      found.push({ workflowId: execution.workflowId, type: execution.type, startedAt: execution.startTime.toISOString(), ...(execution.memo ? { memo: execution.memo } : {}) });
    }
    return found;
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
  async decode(payloads) {
    const { payloadCodecs, payloadConverter } = (await client()).options.loadedDataConverter;
    let decoded = [...payloads] as Decodable;
    for (const codec of [...payloadCodecs].reverse()) decoded = await codec.decode(decoded);
    return decoded.map((payload) => payloadConverter.fromPayload(payload));
  },
});

export const temporalProjectArchive = (client: () => Promise<Client>, projects: Pick<ProjectsStore, 'archive' | 'getProjects'>, taskQueue: string): ProjectArchive => ({
  archive: (projectId) => projects.archive(projectId),
  async keep(projectId) {
    const owner = (await projects.getProjects()).find((project) => project.id === projectId)?.ownerId;
    if (!owner) throw new Error(`the project ${projectId} has no owner to keep it for`);
    const temporal = await client();
    const purge = await withWorkFor({ project: projectId, removing: 'project' }, () => temporal.workflow.start(PURGE_PROJECT_WORKFLOW, {
      ...purgeStart(projectId, taskQueue),
      ...startedFor(owner),
      workflowIdConflictPolicy: 'USE_EXISTING',
    }));
    const due = keptUntil(await purge.describe());
    if (!due) throw new Error(`Temporal did not say when the purge of ${projectId} is due`);
    return { keptUntil: due.toISOString() };
  },
});

export interface DeletionTold {
  down(down: ServiceDown): Promise<void>;
  back(step: string): Promise<void>;
  attempt(): number;
}

type Step = (...args: never[]) => Promise<unknown>;

export function tellingWhenDown<T extends { [K in keyof T]: Step }>(activities: T, told: DeletionTold): T {
  const telling = Object.entries(activities as Record<string, Step>).map(([step, run]) => [step, async (...args: never[]) => {
    try {
      const done = await run(...args);
      if (told.attempt() > 1) await told.back(step);
      return done;
    } catch (err) {
      if (err instanceof DependencyDownError) {
        await told.down({ step, dependency: err.dependency, name: DEPENDENCIES[err.dependency].name, since: err.since, reason: err.reason });
      }
      throw err;
    }
  }]);
  return Object.fromEntries(telling) as T;
}

export const deletionToldThrough = (client: () => Promise<Client>): DeletionTold => {
  const deletion = async () => {
    const workflowId = Context.current().info.workflowExecution?.workflowId;
    if (!workflowId) throw new Error('a step of a deletion ran outside the deletion\'s workflow');
    return (await client()).workflow.getHandle(workflowId);
  };
  return {
    down: async (down) => { await (await deletion()).signal(SERVICE_DOWN_SIGNAL, down); },
    back: async (step) => { await (await deletion()).signal(SERVICE_BACK_SIGNAL, step); },
    attempt: () => Context.current().info.attempt,
  };
};

export function createProjectDeletionActivities(deps: ProjectDeletionDeps): ProjectDeletionActivities {
  return tellingWhenDown<ProjectDeletionActivities>({
    ...deps.removal,

    StopProjectWorkActivity: ({ projectId }) => cancelOpen(deps.work, projectId),

    async SweepProjectActivity(args) {
      const open = await cancelOpen(deps.work, args.projectId);
      const apps = (await deps.removal.RemoveProjectAppsActivity(args)).length;
      const workspaces = await deps.removal.RemoveProjectWorkspacesActivity(args);
      const secrets = await deps.removal.RemoveProjectSecretsActivity(args);
      return { open, apps, workspaces, secrets: (secrets.workspace ? 1 : 0) + secrets.readers };
    },

    async ArchiveProjectActivity({ projectId }) {
      const kept = await deps.archive.keep(projectId);
      await deps.archive.archive(projectId);
      return kept;
    },
  }, deps.told);
}
