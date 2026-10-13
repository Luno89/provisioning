import type { ToolContract } from '@koala/engine-core';
import type { MemoryItem } from './memory-store.js';
import { SEPARATOR, qualify, slugify } from './mcp-tools.js';

export interface LearnedNotes {
  tools: Record<string, string[]>;
  servers: Record<string, string[]>;
}

export const isToolNote = (memory: Pick<MemoryItem, 'category'>): boolean => memory.category === 'tool_note';

export const noteToolName = (note: Pick<MemoryItem, 'tool' | 'server'>): string | undefined =>
  note.tool ? (note.server ? qualify(note.server, note.tool) : note.tool) : undefined;

export function noteSubject(note: Pick<MemoryItem, 'tool' | 'server'>): string {
  if (note.server && note.tool) return `${note.tool} on ${note.server}`;
  if (note.server) return `the ${note.server} server`;
  return note.tool ?? 'no tool';
}

export function notesForRun(memories: readonly MemoryItem[], model: string | undefined): LearnedNotes {
  const notes: LearnedNotes = { tools: {}, servers: {} };
  const live = memories
    .filter((memory) => isToolNote(memory) && memory.status === 'active' && !memory.invalidAt && (!memory.model || memory.model === model))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const note of live) {
    const tool = noteToolName(note);
    if (tool) (notes.tools[tool] ??= []).push(note.text);
    else if (note.server) (notes.servers[note.server] ??= []).push(note.text);
  }
  return notes;
}

export function withLearned(tools: readonly ToolContract[], notes: LearnedNotes): ToolContract[] {
  return tools.map((tool) => {
    const learned = notes.tools[tool.name];
    const served = tool.servedBy ? notes.servers[tool.servedBy.server] : undefined;
    return {
      ...tool,
      ...(learned?.length ? { learned } : {}),
      ...(tool.servedBy && served?.length ? { servedBy: { ...tool.servedBy, learned: served } } : {}),
    };
  });
}

export function checksForNote(scenarios: readonly { id: string; tools?: readonly string[] | undefined }[], note: Pick<MemoryItem, 'tool' | 'server'>): string[] {
  const tool = noteToolName(note);
  const prefix = note.server ? `${slugify(note.server)}${SEPARATOR}` : undefined;
  return scenarios
    .filter((scenario) => (scenario.tools ?? []).some((name) => (tool ? name === tool : prefix !== undefined && name.startsWith(prefix))))
    .map((scenario) => scenario.id);
}
