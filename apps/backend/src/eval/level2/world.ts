import { v4 as uuidv4 } from 'uuid';
import type { Persona, ProcedureSource, ToolDefinition } from '@koala/agent-engine';
import type { RunEffort } from '@koala/agent-engine/procedure';
import { createEngineHost, type EngineHost, type EngineHostStores } from '../../engine-host/host.js';
import type { ModelServiceLike } from '../../engine-host/registries/endpoints.js';
import type { MemoryItem } from '../../engine-host/drivers/memory-store.js';
import { newTask, withStatus, type Task } from '../../engine-host/tools/tasks.js';
import type { WebTools } from '../../lib/web-tools.js';
import type { ToolCallLog } from './score.js';
import type { Scenario } from './scenario.js';
import { inMemoryConversations } from '../../engine-host/nodes/conversation-nodes.js';

export interface WorldOptions {
  ownerId: string;
  models: ModelServiceLike;
  personas: (ownerId?: string) => Promise<Persona[]>;
  tools: (ownerId?: string) => Promise<ToolDefinition[]>;
  procedures: (ownerId?: string) => Promise<ProcedureSource[]>;
  web?: WebTools | undefined;
  kubeconfig?: string | undefined;
  registryHost?: string | undefined;
  efforts?: { save(effort: RunEffort): Promise<void>; list(ownerId: string, procedureId: string, modelKey?: string): Promise<RunEffort[]> } | undefined;
  now?: (() => string) | undefined;
}

export interface World {
  host: EngineHost;
  tasks(): Task[];
  saved(): { id: string; source: string }[];
  memories(): MemoryItem[];
  calls(): ToolCallLog[];
  acceptProposedWork(): Promise<string[]>;
  release(): Promise<void>;
}

export function createWorld(scenario: Scenario, options: WorldOptions): World {
  const now = options.now ?? (() => new Date().toISOString());
  const tasks = new Map<string, Task>();
  for (const seed of scenario.world?.tasks ?? []) {
    const task = newTask({
      id: seed.id,
      ownerId: options.ownerId,
      title: seed.title,
      doneMeans: seed.doneMeans,
      dependsOn: seed.dependsOn ?? [],
      ...(seed.agent ? { agent: seed.agent } : {}),
      ...(seed.checks ? { checks: seed.checks } : {}),
    }, now());
    tasks.set(task.id, { ...task, status: seed.status ?? 'accepted' });
  }

  const memories = (scenario.world?.memories ?? []).map((memory): MemoryItem => ({
    id: uuidv4(),
    ownerId: options.ownerId,
    title: memory.title,
    text: memory.text,
    category: (memory.category ?? 'lessons_learned') as MemoryItem['category'],
    createdAt: now(),
    updatedAt: now(),
  }));

  const procedures = new Map<string, ProcedureSource>();
  for (const procedure of scenario.world?.procedures ?? []) {
    procedures.set(procedure.id, {
      id: procedure.id,
      ownerId: options.ownerId,
      version: procedure.version,
      source: JSON.stringify(procedure),
      updatedAt: now(),
    });
  }

  const calls: ToolCallLog[] = [];

  const stores: EngineHostStores = {
    conversations: inMemoryConversations(),
    personas: { list: options.personas },
    tools: { list: options.tools },
    procedures: {
      list: async (ownerId?: string) => [...(await options.procedures(ownerId)).filter((source) => !procedures.has(source.id)), ...procedures.values()],
      get: async (_ownerId: string, id: string) => procedures.get(id),
      save: async (source: ProcedureSource) => { procedures.set(source.id, source); },
    },
    tasks: {
      list: async () => [...tasks.values()],
      save: async (task: Task) => { tasks.set(task.id, task); },
    },
    memories: {
      list: async () => [...memories],
      save: async (item: MemoryItem) => { memories.push(item); },
    },
  };

  const files = Object.entries(scenario.world?.files ?? {});
  const host = createEngineHost({
    models: options.models,
    stores,
    ...(options.web ? { web: options.web } : {}),
    ...(options.kubeconfig ? { kubeconfig: options.kubeconfig } : {}),
    ...(options.registryHost ? { registryHost: options.registryHost } : {}),
    ...(options.efforts ? { efforts: options.efforts } : {}),
    ...(files.length > 0
      ? {
        onSandbox: async (driver) => {
          for (const [path, content] of files) await driver.writeFile(path, content);
        },
      }
      : {}),
  });

  const runTool = host.tools.run.bind(host.tools);
  host.tools.run = async (args) => {
    const outcome = await runTool(args);
    calls.push({ runId: args.ticket.runId, name: args.name, arguments: args.arguments, ok: outcome.ok !== false, digest: outcome.digest ?? '' });
    return outcome;
  };

  const seeded = new Map([...procedures].map(([id, source]) => [id, source.source]));

  return {
    host,
    tasks: () => [...tasks.values()],
    saved: () => [...procedures.values()]
      .filter((source) => seeded.get(source.id) !== source.source)
      .map((source) => ({ id: source.id, source: source.source })),
    memories: () => [...memories],
    calls: () => [...calls],
    acceptProposedWork: async () => {
      const proposed = [...tasks.values()].filter((task) => task.status === 'proposed');
      for (const task of proposed) tasks.set(task.id, withStatus(task, 'accepted', now()));
      return proposed.map((task) => task.id);
    },
    release: async () => {
      await host.runEnvironments.sweep(Number.MAX_SAFE_INTEGER).catch(() => []);
    },
  };
}
