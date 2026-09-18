import { v4 as uuidv4 } from 'uuid';
import {
  stepImplementation,
  valueImplementation,
  type NodeImplementation,
  type RecalledMemory,
} from '@koala/agent-engine/procedure';
import { renderMemoryContext, selectForContext, unreachableMemory, type MemoryItem } from '../drivers/memory-store.js';
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
});

export function createMemoryNodes(services: HostNodeServices): NodeImplementation[] {
  return [
    valueImplementation('recall-memory', async ({ node, run }) => {
      const all = await services.memories.list(run.launch.ownerId);
      const { kept, dropped } = selectForContext(all.filter(inScope(node.settings.scope)), run.launch.projectId, {
        maxChars: typeof node.settings.maxChars === 'number' ? node.settings.maxChars : DEFAULT_MEMORY_CHARS,
      });

      return { outputs: { memories: kept.map(recalled), text: renderMemoryContext(kept, dropped) } };
    }),

    stepImplementation('save-memory', async ({ node, inputs, run }) => {
      const text = String(inputs.text ?? '').trim();
      if (!text) return { exit: 'refused', outputs: { memory: { reason: 'there was nothing to remember' } } };

      const wiredTitle = typeof inputs.title === 'string' ? inputs.title.trim() : '';
      const title = wiredTitle || text.split('\n')[0]!.slice(0, 60);
      const at = services.now?.() ?? new Date().toISOString();
      const scope = node.settings.scope === 'project' ? 'project' : 'global';

      const item: MemoryItem = {
        id: services.newId?.() ?? uuidv4(),
        ownerId: run.launch.ownerId,
        ...(run.launch.projectId ? { projectId: run.launch.projectId } : {}),
        category: (typeof node.settings.category === 'string' ? node.settings.category : 'lessons_learned') as MemoryItem['category'],
        scope,
        recommendedScope: scope,
        status: 'active',
        title,
        text,
        source: 'agent_tool',
        createdAt: at,
        updatedAt: at,
      };

      const unreachable = unreachableMemory(item);
      if (unreachable) return { exit: 'refused', outputs: { memory: { reason: unreachable } } };

      await services.memories.save(item);
      return { exit: 'saved', outputs: { memory: item } };
    }),
  ];
}
