import { checkDefinition, type ToolDefinition } from '@koala/agent-engine';
import { KUBE_TOOLS, MCP_TOOLS, SECRET_TOOLS, TASK_TOOLS, WORKSPACE_TOOLS } from '../engine-host/index.js';
import { GROVE_TOOLS } from '../engine-host/tools/grove-tools-catalogue.js';
import { sameSeededRow } from './seed-diff.js';

export const ENGINE_TOOL_SEEDS: ToolDefinition[] = [...TASK_TOOLS, ...GROVE_TOOLS, ...WORKSPACE_TOOLS, ...SECRET_TOOLS, ...MCP_TOOLS, ...KUBE_TOOLS];

export interface EngineToolStore {
  getEngineTools(ownerId?: string): Promise<ToolDefinition[]>;
  saveEngineTool(tool: ToolDefinition): Promise<void>;
  deleteEngineTool(ownerId: string | undefined, name: string): Promise<void>;
}

export interface SeedToolOptions {
  implemented?: ReadonlySet<string> | undefined;
}

export async function seedEngineTools(
  store: EngineToolStore,
  options: SeedToolOptions = {},
): Promise<number> {
  const stored = await store.getEngineTools().catch(() => [] as ToolDefinition[]);
  const builtIn = new Map(
    stored.filter((row) => row.ownerId === undefined).map((row) => [row.name, row]),
  );

  let seeded = 0;
  for (const seed of ENGINE_TOOL_SEEDS) {
    const existing = builtIn.get(seed.name);
    if (existing && sameSeededRow(existing, seed)) continue;

    const problems = checkDefinition(seed);
    if (problems.length > 0) {
      throw new Error(`${seed.name} is not a valid declaration: ${problems.map((p) => p.message).join('; ')}`);
    }
    if (options.implemented && !options.implemented.has(seed.name)) {
      throw new Error(`${seed.name} is declared but nothing implements it — it would refuse at dispatch`);
    }

    await store.saveEngineTool({ ...seed });
    seeded += 1;
  }

  const shipped = new Set(ENGINE_TOOL_SEEDS.map((seed) => seed.name));
  for (const name of builtIn.keys()) {
    if (shipped.has(name)) continue;
    await store.deleteEngineTool(undefined, name);
    seeded += 1;
  }
  return seeded;
}
