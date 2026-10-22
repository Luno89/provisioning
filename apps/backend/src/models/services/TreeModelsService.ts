import { machineChoice, type GroupDefinition, type MachineChoice } from '@koala/agent-engine/procedure';
import type { ModelProvider } from '../lib/model-registry.js';
import { groveAgentOf, resolveTreeType, type ProjectsStore } from '../../projects/index.js';
import { handsWorkToMachine, modelAgentsOf, treeModelProblem, withTreeModel, type TreeAgent } from '../lib/tree-models.js';
import { machineChoiceProblem, type ChosenMachine } from '../../machines/index.js';

export type TreeModelsStore = Pick<ProjectsStore, 'getTrees' | 'saveTree' | 'getTreeTypes'>;

export type AgentOwnModel = { modelId: string } | { machine: string } | { problem: string };

export interface TreeModelRow {
  agent: string;
  name: string;
  describe?: string | undefined;
  chosen?: { modelId: string; gone?: true | undefined } | undefined;
  own: AgentOwnModel;
  noMachine?: true | undefined;
}

export type TreeModelsOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404; error: string };

export interface TreeModelsDeps {
  store: TreeModelsStore;
  models: {
    list(ownerId: string): Promise<ModelProvider[]>;
    route(ownerId: string, modelId?: string | null, endpointId?: string | null): Promise<{ provider: ModelProvider }>;
  };
  agentOf(ownerId: string, slug: string): Promise<TreeAgent | undefined>;
  machines?: ((ownerId: string) => Promise<readonly (ChosenMachine & { id: string })[]>) | undefined;
  groups?: (() => readonly GroupDefinition[]) | undefined;
  now?: (() => string) | undefined;
}

export class TreeModelsService {
  constructor(private readonly deps: TreeModelsDeps) {}

  private async tree(ownerId: string, treeId: string) {
    return (await this.deps.store.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
  }

  private async agents(ownerId: string, type: string): Promise<TreeAgent[]> {
    const spec = await resolveTreeType(this.deps.store, ownerId, type);
    return modelAgentsOf(groveAgentOf(spec), (slug) => this.deps.agentOf(ownerId, slug), this.deps.groups?.() ?? []);
  }

  private async own(ownerId: string, agent: TreeAgent): Promise<AgentOwnModel> {
    if (machineChoice(agent.endpointId)) return { machine: agent.endpointId! };
    try {
      return { modelId: (await this.deps.models.route(ownerId, undefined, agent.endpointId)).provider.id };
    } catch (err) {
      return { problem: (err as Error).message };
    }
  }

  private async machineProblem(ownerId: string): Promise<(choice: MachineChoice) => string | undefined> {
    if (!this.deps.machines) return () => 'machines cannot be checked here';
    const machines = await this.deps.machines(ownerId);
    return (choice) => machineChoiceProblem(machines.find((machine) => machine.id === choice.deviceId), choice.agent, { waitsToConnect: true, model: choice.model });
  }

  async view(ownerId: string, treeId: string): Promise<TreeModelsOutcome<{ rows: TreeModelRow[] }>> {
    const tree = await this.tree(ownerId, treeId);
    if (!tree) return { ok: false, status: 404, error: 'Tree not found' };
    const [agents, models, machineProblem] = await Promise.all([this.agents(ownerId, tree.type), this.deps.models.list(ownerId), this.machineProblem(ownerId)]);
    const known = new Set(models.map((model) => model.id));
    const present = (modelId: string): boolean => {
      const machine = machineChoice(modelId);
      return machine ? !machineProblem(machine) : known.has(modelId);
    };
    const rows = await Promise.all(agents.map(async (agent): Promise<TreeModelRow> => {
      const chosen = tree.models?.[agent.slug];
      return {
        agent: agent.slug,
        name: agent.name,
        ...(agent.describe ? { describe: agent.describe } : {}),
        ...(chosen ? { chosen: { modelId: chosen, ...(present(chosen) ? {} : { gone: true as const }) } } : {}),
        own: await this.own(ownerId, agent),
        ...(handsWorkToMachine(agent) ? {} : { noMachine: true as const }),
      };
    }));
    return { ok: true, value: { rows } };
  }

  async problem(ownerId: string, treeId: string, agent: string, modelId: string | null): Promise<{ status: 400 | 404; error: string } | undefined> {
    const tree = await this.tree(ownerId, treeId);
    if (!tree) return { status: 404, error: 'Tree not found' };
    const [agents, models, machineProblem] = await Promise.all([this.agents(ownerId, tree.type), this.deps.models.list(ownerId), this.machineProblem(ownerId)]);
    const problem = treeModelProblem(agents, agent, modelId, models.map((model) => model.id), machineProblem);
    return problem ? { status: 400, error: problem } : undefined;
  }

  async describe(ownerId: string, treeId: string): Promise<string | undefined> {
    const view = await this.view(ownerId, treeId);
    if (!view.ok || !view.value.rows.length) return undefined;
    const models = await this.deps.models.list(ownerId);
    const named = (id: string): string => models.find((model) => model.id === id)?.name ?? id;
    const line = (row: TreeModelRow): string => {
      if (row.chosen) {
        const machine = machineChoice(row.chosen.modelId);
        if (machine) return row.chosen.gone ? `${machine.agent} on a machine (id ${row.chosen.modelId}), chosen for this tree, but that machine or its agent can no longer do the work, so its runs fail until another is chosen` : `${machine.agent} on the person's machine (id ${row.chosen.modelId}), chosen for this tree`;
        return row.chosen.gone ? `${row.chosen.modelId}, chosen for this tree but no longer among the person's models, so its runs fail until another is chosen` : `${named(row.chosen.modelId)} (id ${row.chosen.modelId}), chosen for this tree`;
      }
      if ('machine' in row.own) return 'always on its machine, set in the Studio';
      if ('problem' in row.own) return `its own, which it cannot use: ${row.own.problem}`;
      return `its own, ${named(row.own.modelId)} (id ${row.own.modelId})`;
    };
    return ['Models in this tree\'s work:', ...view.value.rows.map((row) => `- ${row.name} (${row.agent}): ${line(row)}`)].join('\n');
  }

  async set(ownerId: string, treeId: string, body: unknown): Promise<TreeModelsOutcome<{ rows: TreeModelRow[] }>> {
    const { agent, modelId } = (body ?? {}) as { agent?: unknown; modelId?: unknown };
    if (typeof agent !== 'string' || !agent) return { ok: false, status: 400, error: 'say which agent, as "agent"' };
    if (modelId !== null && (typeof modelId !== 'string' || !modelId)) return { ok: false, status: 400, error: 'say "modelId": a model, or null for the agent\'s own' };
    const problem = await this.problem(ownerId, treeId, agent, modelId);
    if (problem) return { ok: false, ...problem };
    const tree = (await this.tree(ownerId, treeId))!;
    const { models: _was, ...rest } = tree;
    const next = withTreeModel(tree.models, agent, modelId);
    await this.deps.store.saveTree({ ...rest, ...(next ? { models: next } : {}), updatedAt: this.deps.now?.() ?? new Date().toISOString() });
    return this.view(ownerId, treeId);
  }

  async modelFor(ownerId: string, treeId: string, agent: string): Promise<{ modelId?: string | undefined } | undefined> {
    const tree = await this.tree(ownerId, treeId);
    if (!tree) return undefined;
    const chosen = tree.models?.[agent];
    return chosen ? { modelId: chosen } : {};
  }
}

export const treeAgentsFrom = (registry: { runnable(ownerId: string, slug: string): Promise<{ agent: { slug: string; name: string; description?: string | undefined; model?: { endpointId?: string | null | undefined } | undefined }; procedure: TreeAgent['procedure'] } | undefined> }) =>
  async (ownerId: string, slug: string): Promise<TreeAgent | undefined> => {
    const runnable = await registry.runnable(ownerId, slug).catch(() => undefined);
    if (!runnable) return undefined;
    return {
      slug,
      name: runnable.agent.name,
      ...(runnable.agent.description ? { describe: runnable.agent.description } : {}),
      ...(runnable.agent.model?.endpointId ? { endpointId: runnable.agent.model.endpointId } : {}),
      procedure: runnable.procedure,
    };
  };
