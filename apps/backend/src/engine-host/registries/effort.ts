import type { Procedure } from '@koala/agent-engine/procedure';
import type { RunBudget } from '@koala/agent-engine';
import { limitsFor, replyCeilingFor, trackRecord, type RunEffort } from '@koala/agent-engine/procedure';
import type { AgentRegistry } from './registry.js';
import type { EndpointResolverOptions } from './endpoints.js';

export interface RunLimitsArgs {
  ownerId: string;
  agentSlug: string;
  procedure: Procedure;
  modelId?: string | undefined;
}

export interface RunLimits {
  modelKey: string;
  modelLabel: string;
  limits: RunBudget;
}

export const UNRESOLVED_MODEL = 'unresolved';

export interface EffortTrackerOptions {
  models: EndpointResolverOptions['models'];
  registry: Pick<AgentRegistry, 'agent'>;
  store: {
    save(effort: RunEffort): Promise<void>;
    list(ownerId: string, procedureId: string, modelKey?: string): Promise<RunEffort[]>;
  };
}

export function createEffortTracker(options: EffortTrackerOptions) {
  return {
    async limits(args: RunLimitsArgs): Promise<RunLimits> {
      const agent = await options.registry.agent(args.ownerId, args.agentSlug);
      const resolved = await options.models
        .resolveBaseUrl(args.ownerId, args.modelId, agent?.model?.endpointId ?? undefined)
        .catch(() => undefined);

      if (!resolved) return { modelKey: UNRESOLVED_MODEL, modelLabel: 'no model', limits: { ...args.procedure.budget } };

      const history = await options.store.list(args.ownerId, args.procedure.id, resolved.provider.id);
      return {
        modelKey: resolved.provider.id,
        modelLabel: resolved.provider.name,
        limits: limitsFor(trackRecord(history), args.procedure.budget),
      };
    },

    async replyCeiling(args: { ownerId: string; procedureId: string; modelKey: string; agentSlug: string }): Promise<number | undefined> {
      const history = await options.store.list(args.ownerId, args.procedureId, args.modelKey);
      return replyCeilingFor(history, args.agentSlug);
    },

    async record(effort: RunEffort): Promise<void> {
      await options.store.save(effort);
    },
  };
}

export type EffortTracker = ReturnType<typeof createEffortTracker>;
