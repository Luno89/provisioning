/**
 * What a leaf learns, so the next one does not start from nothing.
 *
 * ── THE WASTE THIS EXISTS TO STOP ──
 * The memory bank was wired into the Lab and nowhere else: `ExecuteLeafActivity` never read a
 * memory or wrote one, so every leaf rediscovered the same repository from scratch, forever.
 *
 * Measured on a five-leaf plan. Three leaves had already built and merged modules into the repo
 * when a fourth spent its entire step budget on `ls -la`, `cat package.json`, `git log` and reading
 * two source files — twice, across two attempts — and never wrote the one small module it was asked
 * for. A later leaf did the same hunting for a test runner. Neither was short of ability. Both were
 * rediscovering facts that were already known.
 *
 * ── THE SPLIT THAT MAKES THIS SAFE ──
 * Auto-extracted memory is prompt injection with a friendly name: whatever lands here is read by
 * every future leaf on the project, and a wrong lesson is worse than no lesson because it is
 * confidently repeated. So the two kinds are treated differently:
 *
 *   · ENVIRONMENT FACTS are read off the repository — the file layout, the package name, the test
 *     command that is actually configured. They cannot be wrong in the way an inference can, so
 *     they go in ACTIVE and take effect immediately. This is the half that stops the rediscovery.
 *   · LESSONS are inferred from a failure, and inference is where a plausible wrong conclusion
 *     comes from. They go in as PENDING_REVIEW, which `buildMemoryContext` excludes, so a human
 *     decides whether the harness should carry them.
 *
 * That boundary is the whole safety argument. Nothing a model concluded reaches a future prompt
 * without somebody agreeing to it.
 */
import type { MemoryItem } from './memory-store.js';
import type { Leaf } from './leaves.js';

/** Keeps a fact readable and stops a huge tree flooding every later prompt. */
const MAX_FACT_CHARS = 1200;
const MAX_LESSON_CHARS = 400;

export interface LeafMemoryInput {
  leaf: Pick<Leaf, 'id' | 'ownerId' | 'title' | 'projectId'>;
  /** `git ls-files` output from the finished workspace — the layout, as it actually is. */
  trackedFiles: string[];
  /** The run's own summary, used only to recognise a failure shape. */
  summary: string;
  succeeded: boolean;
  /** Artifact paths the leaf promised and did not deliver. */
  missingArtifacts: string[];
  /** Tail of a failing verification, when there was one. */
  verifyOutput?: string | undefined;
  now?: () => string;
  newId?: () => string;
}

const id = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * The repository layout, as a fact.
 *
 * Deliberately just the paths. A summary of what each file DOES would be an inference, and would
 * belong on the other side of the line drawn above — and would also go stale the moment a leaf
 * changed one.
 */
function layoutFact(input: LeafMemoryInput, when: string, makeId: () => string): MemoryItem | undefined {
  if (input.trackedFiles.length === 0) return undefined;

  const listed = input.trackedFiles.join(', ').slice(0, MAX_FACT_CHARS);
  return {
    id: makeId(),
    ownerId: input.leaf.ownerId,
    ...(input.leaf.projectId ? { projectId: input.leaf.projectId } : {}),
    category: 'environment_facts',
    // A layout is about a repository, so it needs the project it describes. See the note on
    // `failureLesson` for the shape this avoids.
    scope: input.leaf.projectId ? 'project' : 'global',
    recommendedScope: 'project',
    // ACTIVE: read off git, not concluded from anything. See the note at the top of this file.
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

/**
 * A lesson from a failure, for a human to accept or throw away.
 *
 * Pattern-matched rather than model-written, like the Lab's extractor: a second model call to
 * decide what to remember is both a cost on every failure and one more place for a confident wrong
 * answer to enter.
 */
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
    // The failure this whole file is aimed at, recorded so a human can see how often it happens.
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
    /**
     * ── SCOPE FOLLOWS THE DATA, BECAUSE THE ALTERNATIVE IS INVISIBLE ──
     *
     * This was `scope: 'project'` unconditionally while `projectId` was set only when the leaf had
     * one. `buildMemoryContext` gives a project-scoped memory to a leaf only when the ids match, so
     * every lesson from a project-less leaf matched nothing, ever. Measured: 25 such rows on this
     * instance, written and never once read.
     *
     * Research personas (`repo: false`) have no project by design, and their failures are usually
     * about the harness or the image rather than about a repository — "a command the sandbox does
     * not have" is a fact about the environment everywhere. Owner-global is both reachable and the
     * more accurate claim. Where a project exists, it is used.
     */
    scope: input.leaf.projectId ? 'project' : 'global',
    recommendedScope: 'project',
    /**
     * ── THE QUEUE IS GONE; THE JUDGEMENT IS NOT ──
     *
     * This was `pending_review`, on the rule stated at the top of this file: nothing a model
     * concluded reaches a future prompt without somebody agreeing to it. The rule was right and the
     * mechanism was not — measured on this instance, 124 of 143 memories were sitting unread in
     * that queue, so what the harness had learned from failures reached nothing, ever.
     *
     * Admission is now decided against what is already stored (lib/memory-decide.ts), which is the
     * question a reviewer would have been answering. `active` here means "eligible", not "kept":
     * `admitMemory` still gets to say NOOP, and every retirement is reversible.
     */
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

  // Only on failure. A successful run's "lesson" is that things worked, which is not worth carrying
  // into every future prompt on the project.
  if (!input.succeeded) {
    const lesson = failureLesson(input, when, makeId);
    if (lesson) out.push(lesson);
  }
  return out;
}

/**
 * Replaces the previous layout fact rather than stacking another one.
 *
 * Every leaf produces one, so without this a ten-leaf project would carry ten near-identical file
 * listings into every prompt — the memory bank becoming the context bloat it exists to prevent.
 *
 * ── IT INVALIDATES; IT NO LONGER DELETES ──
 * This used to return ids for `db.deleteMemory`, and the row was gone. That made one question
 * unanswerable: what did the harness believe when a given leaf ran? Failure review and the judge
 * both read a finished leaf and ask exactly that, and a deleted layout fact cannot be consulted.
 *
 * The replacement carries `invalidAt` and `supersededBy`, so the history is intact and
 * `buildMemoryContext` still shows only what is current. It also costs nothing to get wrong, which
 * is what makes it safe for a model rather than a human to decide what supersedes what
 * (memory-decide.ts).
 */
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
        // Already retired by an earlier run. Re-stamping it would move the moment it stopped being
        // true forward every time a leaf finishes, which is the one thing the field is for.
        && !m.invalidAt)
      .map((m) => ({ ...m, invalidAt: now, supersededBy: item.id, updatedAt: now })));
  }
  return { save: incoming, invalidate };
}
