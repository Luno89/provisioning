import type { RunEnvironment } from '../temporal/contracts.js';
import type { EnvironmentResolver } from './environments.js';
import { destroyWorkspace, retirePod, workspaceRunning, type KubeRunner } from './kube.js';
import { POD, workspaceName } from './workspace.js';

export const GROVE_WORKSPACE_AGENTS = ['planner', 'leaf-executor', 'executor', 'judge'] as const;

export type TreeSandbox = Extract<RunEnvironment, { kind: 'sandbox' }>;

export type TreeWorkspaceState = 'none' | 'parked' | 'running';

export interface TreeWorkspaces {
  describe(request: { treeId: string; ownerId: string }): Promise<TreeSandbox>;
  state(treeId: string): Promise<TreeWorkspaceState>;
  park(treeId: string): Promise<void>;
  release(treeId: string): Promise<void>;
}

export const treeWorkspaceRunId = (treeId: string): string => `tree-${treeId}`;

export function createTreeWorkspaces(options: { resolver: EnvironmentResolver; kube: KubeRunner }): TreeWorkspaces {
  const namespaceOf = (treeId: string): string => workspaceName(treeWorkspaceRunId(treeId));

  return {
    describe: ({ treeId, ownerId }) => options.resolver.describeShared({
      ticket: { runId: treeWorkspaceRunId(treeId), depth: 0, ownerId, agentSlug: 'grove-runner', trigger: 'user' },
      agents: GROVE_WORKSPACE_AGENTS,
    }),

    async state(treeId) {
      const namespace = namespaceOf(treeId);
      const found = await options.kube(['get', 'namespace', namespace, '-o', 'name'], undefined, 15_000);
      if (found.exitCode !== 0) return 'none';
      return (await workspaceRunning(options.kube, namespace, POD).catch(() => false)) ? 'running' : 'parked';
    },

    park: (treeId) => retirePod(options.kube, namespaceOf(treeId), POD),

    release: (treeId) => destroyWorkspace(options.kube, namespaceOf(treeId)),
  };
}
