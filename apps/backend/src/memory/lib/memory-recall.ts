import { DEFAULT_CONTEXT_MARGIN, DEFAULT_MIN_REPLY_TOKENS } from '@koala/agent-engine/procedure';
import type { MemoryItem } from './memory-store.js';

const CHARS_PER_TOKEN = 4;

export function recalledInOrder(memories: readonly MemoryItem[], rankedIds: readonly string[]): MemoryItem[] {
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  return rankedIds.flatMap((id) => byId.get(id) ?? []);
}

export const roomForMemories = (contextTokens: number): number =>
  Math.max(0, (contextTokens - DEFAULT_CONTEXT_MARGIN - DEFAULT_MIN_REPLY_TOKENS) * CHARS_PER_TOKEN);

export function memoryPointer(memories: readonly MemoryItem[]): string {
  if (!memories.length) return 'WHAT KOALA REMEMBERS\nNothing remembered bears on this task yet. If something comes up that earlier work may have settled, look it up by meaning with search_memories.';
  return [
    'WHAT KOALA REMEMBERS',
    'Koala remembers these for this task, most relevant first. Read the ones that bear on your work with search_memories before you start, and search it again whenever something comes up:',
    ...memories.map((memory) => `- ${memory.title}`),
  ].join('\n');
}

export const memoryPointerDown = (why: string): string =>
  `WHAT KOALA REMEMBERS\nKoala's memory cannot be read just now: ${why}. Until it answers, search_memories says the same.`;
