import { unreachableMemory, type MemoryItem } from './memory-store.js';

export const MEMORY_WRITE_CATEGORIES = new Set<MemoryItem['category']>(['lessons_learned', 'environment_facts', 'prompt_guidance']);

export interface MemoryWrite {
  ownerId: string;
  projectId?: string | undefined;
  text: string;
  title?: string | undefined;
  category?: string | undefined;
  scope?: string | undefined;
  model?: string | undefined;
  replaces?: string | undefined;
  provenance?: MemoryItem['provenance'] | undefined;
}

export type MemoryWritePlan =
  | { refused: string }
  | { known: MemoryItem }
  | { item: MemoryItem; replacing?: MemoryItem | undefined };

export type MemoryForgetPlan = { refused: string } | { retired: MemoryItem };

export const sameMemoryText = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

export const currentMemory = (memory: MemoryItem): boolean => !memory.invalidAt && memory.status !== 'pending_review';

export function planMemoryWrite(memories: readonly MemoryItem[], write: MemoryWrite, at: string, id: string): MemoryWritePlan {
  const body = write.text.trim();
  if (!body) return { refused: 'there was nothing to remember' };
  const title = write.title?.trim() || body.split('\n')[0]!.slice(0, 60);
  const asked = write.category as MemoryItem['category'] | undefined;
  const category = asked && MEMORY_WRITE_CATEGORIES.has(asked) ? asked : 'lessons_learned';
  const scope = write.scope === 'global' || (!write.projectId && write.scope !== 'project') ? 'global' : 'project';
  const mine = memories.filter((memory) => memory.ownerId === write.ownerId).filter(currentMemory);

  const replacing = write.replaces ? mine.find((memory) => memory.id === write.replaces) : undefined;
  if (write.replaces && !replacing) return { refused: `there is no current memory ${write.replaces} to replace; nothing was saved` };

  const known = mine.find((memory) => memory.id !== write.replaces && memory.model === write.model && sameMemoryText(memory.title, title) && sameMemoryText(memory.text, body));
  if (known) return { known };

  const item: MemoryItem = {
    id,
    ownerId: write.ownerId,
    ...(scope === 'project' && write.projectId ? { projectId: write.projectId } : {}),
    category,
    ...(write.model ? { model: write.model } : {}),
    scope,
    recommendedScope: scope,
    status: 'active',
    title,
    text: body,
    source: 'agent_tool',
    ...(write.provenance ? { provenance: write.provenance } : {}),
    createdAt: at,
    updatedAt: at,
  };
  const unreachable = unreachableMemory(item);
  if (unreachable) return { refused: unreachable };
  return { item, ...(replacing ? { replacing } : {}) };
}

export function planMemoryForget(memories: readonly MemoryItem[], ownerId: string, id: string, why: string, at: string): MemoryForgetPlan {
  const target = memories.filter((memory) => memory.ownerId === ownerId).filter(currentMemory).find((memory) => memory.id === id);
  if (!target) return { refused: `there is no current memory ${id}` };
  return { retired: { ...target, invalidAt: at, updatedAt: at, text: `${target.text}\n(retired: ${why})` } };
}
