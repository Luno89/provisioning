import {
  BUILT_IN_GROUPS,
  WORKFLOW_IMPLEMENTATIONS,
  builtInCatalogue,
  createNodeExecutor,
  createOrchestrationNodes,
  runProcedure,
  type ChildOutcomeValue,
  type NodeCatalogue,
  type NodeExecutor,
  type NodeImplementation,
  type OrchestrationPorts,
  type QuestionAnswer,
  type NodeTrace,
} from '@koala/agent-engine/procedure';
import { createEnvironmentNodes } from './environment-nodes.js';
import { createMemoryNodes } from './memory-nodes.js';
import { createModelNodes } from './model-nodes.js';
import { createToolNodes } from './tool-nodes.js';
import { createCodeNodes } from './code-nodes.js';
import { handleFor, launchFor, ticketFor } from '../temporal/contracts.js';
import type { AgentRegistry } from '../registries/registry.js';
import type { HostNodeServices } from './services.js';

export function createHostNodes(services: HostNodeServices): NodeImplementation[] {
  return [
    ...createModelNodes(services),
    ...createToolNodes(services),
    ...createMemoryNodes(services),
    ...createEnvironmentNodes(services),
    ...createCodeNodes(services),
  ];
}

export function hostNodesFor(
  implementations: readonly NodeImplementation[],
  runs: readonly ('activity' | 'stream' | 'sandbox')[],
  catalogue: NodeCatalogue = builtInCatalogue(),
): NodeImplementation[] {
  return implementations.filter((implementation) => {
    const placement = catalogue.get(implementation.kind)?.runs;
    return placement !== undefined && (runs as readonly string[]).includes(placement);
  });
}

export interface RunIdentity {
  runId: string;
  agentSlug: string;
  procedureId: string;
  procedureVersion: string;
}

export interface InProcessOptions {
  registry: Pick<AgentRegistry, 'runnable' | 'agent'>;
  approve?: OrchestrationPorts['approve'] | undefined;
  ask?: OrchestrationPorts['ask'] | undefined;
  onTrace?: ((trace: NodeTrace, run: RunIdentity) => void) | undefined;
  signal?: AbortSignal | undefined;
}

const NOBODY_TO_ASK: QuestionAnswer = { answered: false, reason: 'nobody can answer inside this run' };

export function createProcedureExecutor(
  services: HostNodeServices,
  options: InProcessOptions,
  catalogue: NodeCatalogue = builtInCatalogue(),
): NodeExecutor {
  let children = 0;

  const ports: OrchestrationPorts = {
    runTool: ({ nodeId, call, persona, environment, run }) => {
      const handle = handleFor(environment);
      return services.tools.run({
        ticket: ticketFor(run),
        nodeId,
        name: call.name,
        arguments: call.arguments,
        callId: call.id,
        granted: persona.tools,
        ...(handle ? { environment: handle } : {}),
      });
    },

    runChild: async ({ agent, inputs, environment, run }): Promise<ChildOutcomeValue> => {
      children += 1;
      const runId = `${run.identity.runId}-${agent}-${children}`;
      const runnable = await options.registry.runnable(run.launch.ownerId, agent);
      if (!runnable) {
        return { runId, agentId: agent, outcome: 'failed', reason: `there is no agent called "${agent}"`, outputs: {} };
      }

      const caller = await options.registry.agent(run.launch.ownerId, run.identity.agentId);
      if (caller && !(caller.agents ?? []).includes(agent)) {
        return {
          runId,
          agentId: agent,
          outcome: 'failed',
          reason: `${caller.slug} is not allowed to hand work to "${agent}" — grant it the agent first`,
          outputs: {},
        };
      }

      const result = await runProcedure({
        procedure: runnable.procedure,
        catalogue,
        groups: BUILT_IN_GROUPS,
        executor,
        identity: {
          runId,
          parentRunId: run.identity.runId,
          depth: run.identity.depth + 1,
          agentId: agent,
          loopId: runnable.procedure.id,
          loopVersion: runnable.procedure.version,
          trigger: 'agent',
        },
        launch: { ...launchFor(ticketFor(run), run.launch.projectId), ...(environment ? { environment } : {}) },
        inputs: { ...inputs, message: typeof inputs.message === 'string' ? inputs.message : '' },
        budget: runnable.procedure.budget,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onTrace ? { onTrace: (trace) => options.onTrace!(trace, { runId, agentSlug: agent, procedureId: runnable.procedure.id, procedureVersion: runnable.procedure.version }) } : {}),
      });

      return {
        runId,
        agentId: agent,
        outcome: result.outcome,
        ...(result.reason ? { reason: result.reason } : {}),
        outputs: result.finishedBy ? { ...(result.outputs[result.finishedBy] ?? {}) } : {},
      };
    },

    approve: options.approve ?? (async () => false),
    ask: options.ask ?? (async () => NOBODY_TO_ASK),
  };

  const executor = createNodeExecutor(catalogue, [
    ...WORKFLOW_IMPLEMENTATIONS,
    ...createOrchestrationNodes(ports),
    ...createHostNodes(services),
  ]);

  return executor;
}

export { ticketFor, handleFor, type HostNodeServices } from './services.js';
export { withTemperature, type ModelNodeServices } from './model-nodes.js';
export { createModelNodes };
