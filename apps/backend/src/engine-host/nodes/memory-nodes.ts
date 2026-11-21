import {
  stepImplementation,
  valueImplementation,
  type NodeImplementation,
  type NodeRequest,
  type RecalledMemory,
  type StepResult,
} from '@koala/agent-engine/procedure';
import { createMemoryWriter, type MemoryWrite, type MemoryWritten } from '../../memory/index.js';
import { renderMemoryContext, selectForContext, type MemoryItem } from '../drivers/memory-store.js';
import type { HostNodeServices } from './services.js';

const DEFAULT_MEMORY_CHARS = 6000;

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

const written = (outcome: MemoryWritten, exit: string): StepResult => {
  if ('refused' in outcome) return { exit: 'refused', outputs: { memory: { reason: outcome.refused } } };
  return { exit, outputs: { memory: 'known' in outcome ? outcome.known : outcome.saved } };
};

export function createMemoryNodes(services: HostNodeServices): NodeImplementation[] {
  const writer = createMemoryWriter({ store: services.memories, now: services.now, newId: services.newId });

  return [
    valueImplementation('recall-memory', async ({ node, inputs, run }) => {
      const all = await services.memories.list(run.launch.ownerId);
      const { kept, dropped } = selectForContext(all.filter(inScope(node.settings.scope)), run.launch.projectId, {
        maxChars: typeof node.settings.maxChars === 'number' ? node.settings.maxChars : DEFAULT_MEMORY_CHARS,
        agent: run.identity.agentId,
        model: modelOf(inputs.binding),
      });

      return { outputs: { memories: kept.map(recalled), text: renderMemoryContext(kept, dropped) } };
    }),

    stepImplementation('save-memory', async (request) => written(await writer.save(writeOf(request)), 'saved')),

    stepImplementation('update-memory', async (request) => {
      const id = wiredText(request.inputs.id);
      if (!id) return { exit: 'refused', outputs: { memory: { reason: 'give the id of the memory to update' } } };
      return written(await writer.save({ ...writeOf(request), replaces: id }), 'updated');
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
