import { agentsHandedTo, callsModel, machineChoice, type GroupDefinition, type MachineChoice, type Procedure } from '@koala/agent-engine/procedure';

export type TreeModels = Record<string, string>;

export interface TreeAgent {
  slug: string;
  name: string;
  describe?: string | undefined;
  endpointId?: string | null | undefined;
  procedure?: Pick<Procedure, 'nodes' | 'groups' | 'wires' | 'flow' | 'start'> | undefined;
}

export async function modelAgentsOf(grower: string, agentOf: (slug: string) => Promise<TreeAgent | undefined>, shared: readonly GroupDefinition[] = []): Promise<TreeAgent[]> {
  const seen = new Set<string>();
  const found: TreeAgent[] = [];
  let next = [grower];
  while (next.length) {
    const fresh = next.filter((slug) => !seen.has(slug));
    for (const slug of fresh) seen.add(slug);
    const agents = (await Promise.all(fresh.map(agentOf))).filter((agent): agent is TreeAgent => Boolean(agent));
    for (const agent of agents) if (agent.procedure && callsModel(agent.procedure, shared)) found.push(agent);
    next = agents.flatMap((agent) => (agent.procedure ? agentsHandedTo(agent.procedure) : []));
  }
  return found;
}

export const handsWorkToMachine = (agent: TreeAgent): boolean =>
  Boolean(agent.procedure?.nodes.some((node) => node.kind === 'where-it-runs'));

export function treeModelProblem(
  agents: readonly TreeAgent[],
  slug: string,
  modelId: string | null,
  models: readonly string[],
  machineProblem: (choice: MachineChoice) => string | undefined = () => 'machines cannot be checked here',
): string | undefined {
  const agent = agents.find((entry) => entry.slug === slug);
  if (!agent) return `${slug} asks no model anything in this tree's work, so it has no model to choose`;
  if (machineChoice(agent.endpointId)) return `${agent.name} always runs on its machine; change where it runs in the Studio`;
  if (modelId === null) return undefined;
  const machine = machineChoice(modelId);
  if (machine) {
    if (!handsWorkToMachine(agent)) return `${agent.name}'s procedure has no way to hand its work to a machine; give it a Where It Runs step, or choose one of your models`;
    return machineProblem(machine);
  }
  if (!models.includes(modelId)) return `There is no model ${modelId} among yours`;
  return undefined;
}

export function withTreeModel(models: TreeModels | undefined, slug: string, modelId: string | null): TreeModels | undefined {
  const { [slug]: _was, ...rest } = models ?? {};
  const next = modelId ? { ...rest, [slug]: modelId } : rest;
  return Object.keys(next).length ? next : undefined;
}
