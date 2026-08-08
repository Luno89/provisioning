/**
 * The proposed board, as a verify command sees it.
 *
 * ── WHY NOT JUST THE LEAF RECORDS ──
 * A `Leaf` carries an owner, a branch id, a workflow id and timestamps — none of which a predicate
 * about decomposition quality has any business reading, and all of which change between runs. A
 * verify written against them would be asserting on incidental structure, and the first thing that
 * refactored a field would break every planning task at once.
 *
 * ── IDS ARE RESOLVED BACK TO NAMES ──
 * `dependsOn` holds leaf ids and `personaId` holds a persona id, because that is what a database
 * needs. A predicate needs neither: nobody writing `assert(board[1].dependsOn.includes(...))` wants
 * to join a uuid first. Both come back as the names the model actually used, which are also the
 * only parts stable enough to write an assertion against.
 *
 * A dependency pointing at nothing is dropped rather than emitted as a dangling id — the ordering
 * was already lost when the target vanished, and a predicate should not have to handle a shape the
 * board cannot meaningfully be in.
 */
import type { Leaf } from './leaves.js';
import type { Persona } from '@koala/harness-types';

/** One proposed piece of work, as a planning verify command reads it. */
export interface BoardLeaf {
  title: string;
  body: string;
  /** Titles of the leaves this one waits for, in the order the model gave them. */
  dependsOn: string[];
  /** The persona's name, or null when the model assigned none. */
  persona: string | null;
  /** The sandbox toolchain, or null for the default. */
  language: string | null;
  /** Title of the parent, for a decomposition that nests rather than chains. */
  parent: string | null;
}

/**
 * Ordered by creation, which is the order the model proposed them in.
 *
 * That order is itself evidence — a planner that proposes the test before the thing it tests has
 * said something about how it thinks, and sorting by anything else would erase it.
 */
export function serialiseBoard(leaves: Leaf[], personas: Persona[] = []): BoardLeaf[] {
  const titleById = new Map(leaves.map((l) => [l.id, l.title]));
  const personaById = new Map(personas.map((p) => [p.id, p.name]));

  return [...leaves]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((leaf) => ({
      title: leaf.title,
      body: leaf.body ?? '',
      dependsOn: (leaf.dependsOn ?? [])
        .map((id) => titleById.get(id))
        .filter((t): t is string => t !== undefined),
      persona: (leaf.personaId && personaById.get(leaf.personaId)) || null,
      language: leaf.language ?? null,
      parent: (leaf.parentLeafId && titleById.get(leaf.parentLeafId)) || null,
    }));
}

/**
 * What gets written into the sandbox for the verify command to read.
 *
 * Pretty-printed on purpose: when a planning task fails, the first thing anyone does is read this
 * file, and a single line of JSON is not something you read.
 */
export const BOARD_PATH = 'leaves.json';

export function boardFile(leaves: Leaf[], personas: Persona[] = []): { path: string; content: string } {
  return { path: BOARD_PATH, content: `${JSON.stringify(serialiseBoard(leaves, personas), null, 2)}\n` };
}
