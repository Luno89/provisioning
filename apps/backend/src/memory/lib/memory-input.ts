import type { MemoryItem } from './memory-store.js';

export const MEMORY_CATEGORIES = ['lessons_learned', 'environment_facts', 'prompt_guidance', 'practice', 'tool_note'] as const satisfies readonly MemoryItem['category'][];
export const MEMORY_SCOPES = ['project', 'global'] as const satisfies readonly NonNullable<MemoryItem['scope']>[];
export const MEMORY_STATUSES = ['active', 'pending_review', 'trial'] as const satisfies readonly NonNullable<MemoryItem['status']>[];

const oneOf = <T extends string>(choices: readonly T[], value: unknown): T | undefined =>
  choices.find((choice) => choice === value);

export const memoryCategoryIn = (value: unknown): MemoryItem['category'] | undefined => oneOf(MEMORY_CATEGORIES, value);
export const memoryScopeIn = (value: unknown): MemoryItem['scope'] => oneOf(MEMORY_SCOPES, value);
export const memoryStatusIn = (value: unknown): MemoryItem['status'] => oneOf(MEMORY_STATUSES, value);

export interface MemoryChanges {
  category?: MemoryItem['category'];
  scope?: NonNullable<MemoryItem['scope']>;
  status?: NonNullable<MemoryItem['status']>;
  title?: string;
  text?: string;
  projectId?: string | null;
}

export function memoryChangesIn(body: Record<string, unknown>): MemoryChanges | string {
  const changes: MemoryChanges = {};
  if (body.category) {
    const category = memoryCategoryIn(body.category);
    if (!category) return `${String(body.category)} is not a kind of memory`;
    changes.category = category;
  }
  if (body.scope) {
    const scope = memoryScopeIn(body.scope);
    if (!scope) return `a memory's scope is project or global, not ${String(body.scope)}`;
    changes.scope = scope;
  }
  if (body.status) {
    const status = memoryStatusIn(body.status);
    if (!status) return `a memory is active, pending_review or trial, not ${String(body.status)}`;
    changes.status = status;
  }
  if (body.title) changes.title = String(body.title).trim();
  if (body.text) changes.text = String(body.text).trim();
  if (body.projectId !== undefined) changes.projectId = body.projectId === null ? null : String(body.projectId);
  return changes;
}
