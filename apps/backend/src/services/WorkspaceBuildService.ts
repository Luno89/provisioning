import type { StartRunRequest, StartedRun } from '../engine-host/registries/run-starter.js';
import { WORKSPACE_AGENT } from '../extensions/workspace/personas.js';
import { workspaceBuildRunId, touchesWorkspaceFile, type PushedCommit } from '../lib/workspace-builds.js';

export interface WorkspaceBuildDeps {
  runs: { start(request: StartRunRequest): Promise<StartedRun> };
  trees: () => Promise<readonly { id: string; ownerId: string; projectIds?: readonly string[] | undefined }[]>;
  hidden?: ((ownerId: string) => Promise<{ agents: ReadonlySet<string> }>) | undefined;
}

export type WorkspaceBuildStart =
  | { started: true; runId: string }
  | { started: false; reason: 'running' | 'switched-off' };

export class WorkspaceBuildService {
  constructor(private readonly deps: WorkspaceBuildDeps) {}

  async start(ownerId: string, treeId: string, commit: string): Promise<WorkspaceBuildStart> {
    if ((await this.deps.hidden?.(ownerId))?.agents.has(WORKSPACE_AGENT)) return { started: false, reason: 'switched-off' };
    const runId = workspaceBuildRunId(treeId, commit);
    try {
      await this.deps.runs.start({
        ownerId,
        agentSlug: WORKSPACE_AGENT,
        message: 'Build the workspace.',
        inputs: { treeId, commit },
        runId,
        bound: { treeId },
      });
      return { started: true, runId };
    } catch (err) {
      if (/already started|AlreadyStarted/i.test(`${(err as Error)?.name} ${(err as Error)?.message}`)) return { started: false, reason: 'running' };
      throw err;
    }
  }

  async pushed(project: { id: string; ownerId?: string | undefined }, commit: string, commits: readonly PushedCommit[]): Promise<WorkspaceBuildStart[]> {
    const ownerId = project.ownerId;
    if (!ownerId || !touchesWorkspaceFile(commits)) return [];
    const trees = (await this.deps.trees()).filter((tree) => tree.ownerId === ownerId && tree.projectIds?.[0] === project.id);
    return Promise.all(trees.map((tree) => this.start(ownerId, tree.id, commit)));
  }
}
