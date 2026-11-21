import {
  stepImplementation,
  valueImplementation,
  type NodeImplementation,
  type NodeRequest,
  type RecalledMemory,
  type StepResult,
} from '@koala/agent-engine/procedure';
import { createMemoryWriter, memoryPointer, memoryPointerDown, recalledInOrder, roomForMemories, type MemoryWrite, type MemoryWritten } from '../../memory/index.js';
import { renderMemoryContext, selectForContext, type MemoryItem } from '../drivers/memory-store.js';
import type { HostNodeServices } from './services.js';

const lowerFirst = (text: string): string => text.replace(/^./, (first) => first.toLowerCase());

const tokensIn = (value: unknown): number | undefined => {
  const tokens = (value as { contextTokens?: unknown } | undefined)?.contextTokens;
  return typeof tokens === 'number' && tokens > 0 ? tokens : undefined;
};

async function contextTokensOf(services: HostNodeServices, binding: unknown, ownerId: string, modelId: string | undefined): Promise<number> {
  const wired = tokensIn(binding);
  if (wired) return wired;
  if (!modelId) throw new Error('memories are recalled to fit a model\'s context, and this run names no model');
  const { provider } = await services.models.resolveBaseUrl(ownerId, modelId);
  const own = tokensIn(provider);
  if (!own) throw new Error(`memories are recalled to fit a model's context, and ${modelId} reports no context size`);
  return own;
}

const inScope = (scope: unknown) => (memory: MemoryItem): boolean => {
  if (scope === 'project') return memory.scope === 'project';
  if (scope === 'global') return !memory.scope || memory.scope === 'global';
  return true;
};

const recalled = (memory: MemoryItem): RecalledMemory => ({
  id: memory.id,
  title: memory.title,
  text: memory.text,
  category: memory.category,
  scope: memory.scope === 'project' ? 'project' : 'global',
  ...(memory.model ? { model: memory.model } : {}),
});

const wiredText = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

const modelOf = (binding: unknown): string | undefined => {
  const model = (binding as { model?: unknown } | undefined)?.model;
  return typeof model === 'string' && model ? model : undefined;
};

const writeOf = ({ node, inputs, run }: Pick<NodeRequest, 'node' | 'inputs' | 'run'>): MemoryWrite => ({
  ownerId: run.launch.ownerId,
  projectId: run.launch.projectId,
  text: String(inputs.text ?? ''),
  title: wiredText(inputs.title),
  category: typeof node.settings.category === 'string' ? node.settings.category : undefined,
  scope: node.settings.scope === 'project' ? 'project' : 'global',
  model: modelOf(inputs.binding),
});

const written = (outcome: MemoryWritten, exit: string, run: NodeRequest['run'], nodeId: string): StepResult => {
  if ('refused' in outcome) return { exit: 'refused', outputs: { memory: { reason: outcome.refused } } };
  if ('known' in outcome) return { exit, outputs: { memory: outcome.known } };
  if (outcome.unindexed) run.emit({ type: 'notice', level: 'warn', nodeId, message: `Saved, and found once the index answers again: ${lowerFirst(outcome.unindexed)}` } as never);
  return { exit, outputs: { memory: outcome.saved } };
};

export function createMemoryNodes(services: HostNodeServices): NodeImplementation[] {
  const writer = createMemoryWriter({ store: services.memories, now: services.now, newId: services.newId });

  const relevant = async ({ node, inputs, run }: Pick<NodeRequest, 'node' | 'inputs' | 'run'>): Promise<{ memories: MemoryItem[] } | { down: string }> => {
    const { ownerId } = run.launch;
    const all = (await services.memories.list(ownerId)).filter((memory) => memory.ownerId === ownerId);
    const task = wiredText(inputs.task) ?? wiredText(run.inputs.message) ?? '';
    try {
      const ranked = task ? await services.memories.search(ownerId, task, all.length) : [];
      return { memories: recalledInOrder(all, ranked).filter(inScope(node.settings.scope)) };
    } catch (err) {
      const down = lowerFirst((err as Error).message);
      run.emit({ type: 'notice', level: 'warn', nodeId: node.id, message: `This run goes on without its memories: ${down}` } as never);
      return { down };
    }
  };

  return [
    valueImplementation('recall-memory', async (request) => {
      const { inputs, run } = request;
      const found = await relevant(request);
      if ('down' in found) return { outputs: { memories: [], text: '' } };
      const { kept, dropped } = selectForContext(found.memories, run.launch.projectId, {
        preRanked: true,
        maxChars: roomForMemories(await contextTokensOf(services, inputs.binding, run.launch.ownerId, run.launch.modelId)),
        agent: run.identity.agentId,
        model: modelOf(inputs.binding),
      });
      return { outputs: { memories: kept.map(recalled), text: renderMemoryContext(kept, dropped) } };
    }),

    valueImplementation('point-to-memories', async (request) => {
      const found = await relevant(request);
      if ('down' in found) return { outputs: { text: memoryPointerDown(found.down) } };
      const { kept } = selectForContext(found.memories, request.run.launch.projectId, { preRanked: true, maxChars: Number.POSITIVE_INFINITY, agent: request.run.identity.agentId });
      return { outputs: { text: memoryPointer(kept) } };
    }),

    stepImplementation('save-memory', async (request) => written(await writer.save(writeOf(request)), 'saved', request.run, request.node.id)),

    stepImplementation('update-memory', async (request) => {
      const id = wiredText(request.inputs.id);
      if (!id) return { exit: 'refused', outputs: { memory: { reason: 'give the id of the memory to update' } } };
      return written(await writer.save({ ...writeOf(request), replaces: id }), 'updated', request.run, request.node.id);
    }),

    stepImplementation('forget-memory', async ({ inputs, run }) => {
      const id = wiredText(inputs.id);
      const why = wiredText(inputs.why);
      if (!id || !why) return { exit: 'refused', outputs: { memory: { reason: 'give the id to forget and why it is no longer true' } } };
      const outcome = await writer.forget(run.launch.ownerId, id, why);
      if ('refused' in outcome) return { exit: 'refused', outputs: { memory: { reason: outcome.refused } } };
      return { exit: 'forgotten', outputs: { memory: outcome.retired } };
    }),
  ];
}
