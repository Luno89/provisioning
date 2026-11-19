import {
  BUILT_IN_GROUPS,
  HOST_OP_KIND,
  WORKFLOW_IMPLEMENTATIONS,
  createOrchestrationNodes,
  runProcedure,
  type NodeExecutor,
  type NodeImplementation,
  type OrchestrationPorts,
  type Procedure,
} from '@koala/agent-engine/procedure';
import { platformCatalogue } from '../installed.js';
import type { HostOperationRun } from '../types.js';

export const askingNodes = (ask: OrchestrationPorts['ask']): NodeImplementation[] => createOrchestrationNodes({
  runTool: async () => { throw new Error('no tools here'); },
  runChild: async () => { throw new Error('no children here'); },
  approve: async () => false,
  ask,
});

export function hostOpExecutor(operations: Record<string, HostOperationRun>, nodes: readonly NodeImplementation[] = []): NodeExecutor {
  const local = new Map<string, NodeImplementation>([...WORKFLOW_IMPLEMENTATIONS, ...nodes].map((implementation) => [implementation.kind, implementation] as const));
  return {
    async step(request) {
      if (request.node.kind === HOST_OP_KIND) return operations[String(request.node.settings.operation)]!(request);
      const implementation = local.get(request.node.kind);
      if (implementation?.role !== 'step') throw new Error(`no step for ${request.node.kind}`);
      return implementation.run(request) as never;
    },
    async value(request) {
      const implementation = local.get(request.node.kind);
      if (implementation?.role !== 'value') throw new Error(`no value for ${request.node.kind}`);
      return implementation.run(request) as never;
    },
  };
}

export interface HostOpRun {
  procedure: Procedure;
  operations: Record<string, HostOperationRun>;
  nodes?: readonly NodeImplementation[] | undefined;
  runId: string;
  agentId: string;
  ownerId: string;
  inputs: object;
  emit?: ((event: never) => void) | undefined;
}

export const runOnHost = (run: HostOpRun) => runProcedure({
  procedure: run.procedure,
  catalogue: platformCatalogue(),
  groups: BUILT_IN_GROUPS,
  executor: hostOpExecutor(run.operations, run.nodes),
  identity: { runId: run.runId, depth: 0, agentId: run.agentId, loopId: run.procedure.id, loopVersion: '1', trigger: 'user' },
  launch: { ownerId: run.ownerId },
  inputs: run.inputs as Record<string, unknown>,
  bus: { emit: run.emit ?? (() => undefined), subscribe: () => () => undefined } as never,
});
