import type { MemoryItem } from './memory-store.js';
import type { Leaf } from './leaves.js';

const MAX_FACT_CHARS = 1200;
const MAX_LESSON_CHARS = 400;

export interface LeafMemoryInput {
  leaf: Pick<Leaf, 'id' | 'ownerId' | 'title' | 'projectId'>;
  trackedFiles: string[];
  summary: string;
  succeeded: boolean;
  missingArtifacts: string[];
  verifyOutput?: string | undefined;
  now?: () => string;
  newId?: () => string;
}

const id = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function layoutFact(input: LeafMemoryInput, when: string, makeId: () => string): MemoryItem | undefined {
  if (input.trackedFiles.length === 0) return undefined;

  const listed = input.trackedFiles.join(', ').slice(0, MAX_FACT_CHARS);
  return {
    id: makeId(),
    ownerId: input.leaf.ownerId,
    ...(input.leaf.projectId ? { projectId: input.leaf.projectId } : {}),
    category: 'environment_facts',
    scope: input.leaf.projectId ? 'project' : 'global',
    recommendedScope: 'project',
    status: 'active',
    title: 'Repository layout',
    text: `The project repository already contains these files: ${listed}. `
      + 'Read only the ones you need for your task — do not survey the tree.',
    source: 'post_run_extractor',
    provenance: { taskId: input.leaf.id },
    createdAt: when,
    updatedAt: when,
  };
}

function failureLesson(input: LeafMemoryInput, when: string, makeId: () => string): MemoryItem | undefined {
  const output = `${input.verifyOutput ?? ''}\n${input.summary}`;
  let title: string | undefined;
  let text: string | undefined;
  let category: MemoryItem['category'] = 'lessons_learned';

  if (/command not found|ENOENT|not recognized/i.test(output)) {
    category = 'environment_facts';
    title = 'A command the sandbox does not have';
    text = `Work on "${input.leaf.title}" failed because a command was missing from the image: ${output.slice(0, MAX_LESSON_CHARS).trim()}`;
  } else if (/Ran out of steps/i.test(input.summary)) {
    category = 'prompt_guidance';
    title = 'Ran out of steps before finishing';
    text = `"${input.leaf.title}" used its entire step budget without finishing. Its last commands were: `
      + `${input.summary.slice(0, MAX_LESSON_CHARS).trim()}`;
  } else if (input.missingArtifacts.length) {
    title = 'Promised a file it did not deliver';
    text = `"${input.leaf.title}" reported success but these were not committed or unchanged: ${input.missingArtifacts.join(', ')}.`;
  } else if (!input.succeeded) {
    title = `Failed: ${input.leaf.title}`.slice(0, 120);
    text = output.slice(0, MAX_LESSON_CHARS).trim();
  }

  if (!title || !text) return undefined;

  return {
    id: makeId(),
    ownerId: input.leaf.ownerId,
    ...(input.leaf.projectId ? { projectId: input.leaf.projectId } : {}),
    category,
    scope: input.leaf.projectId ? 'project' : 'global',
    recommendedScope: 'project',
    status: 'active',
    title,
    text,
    source: 'post_run_extractor',
    provenance: { taskId: input.leaf.id },
    createdAt: when,
    updatedAt: when,
  };
}

export function extractLeafMemories(input: LeafMemoryInput): MemoryItem[] {
  const when = (input.now ?? (() => new Date().toISOString()))();
  const makeId = input.newId ?? (() => id('mem_leaf'));

  const out: MemoryItem[] = [];
  const layout = layoutFact(input, when, makeId);
  if (layout) out.push(layout);

  if (!input.succeeded) {
    const lesson = failureLesson(input, when, makeId);
    if (lesson) out.push(lesson);
  }
  return out;
}

export function supersede(
  existing: MemoryItem[],
  incoming: MemoryItem[],
  now = new Date().toISOString(),
): { save: MemoryItem[]; invalidate: MemoryItem[] } {
  const invalidate: MemoryItem[] = [];
  for (const item of incoming) {
    if (item.category !== 'environment_facts' || item.title !== 'Repository layout') continue;
    invalidate.push(...existing
      .filter((m) => m.title === 'Repository layout'
        && m.projectId === item.projectId
        && m.ownerId === item.ownerId
        && !m.invalidAt)
      .map((m) => ({ ...m, invalidAt: now, supersededBy: item.id, updatedAt: now })));
  }
  return { save: incoming, invalidate };
}
