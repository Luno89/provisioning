/**
 * Tells the model what work already exists on a branch.
 *
 * Without this the model is blind to its own output: it cannot reference a leaf, cannot answer
 * "what is left?", and — most visibly — proposes the same work again every turn, because from its
 * point of view nothing was ever created.
 *
 * Injected as context rather than exposed as a tool. Tool calling would be better (the model could
 * ask only when it needs to, and could query rather than receive a dump) but nothing here speaks
 * that protocol yet, and a compact list costs less than the round trips would. Worth revisiting
 * when there is a tool layer.
 *
 * Kept pure so the shape of the summary can be tested without a model.
 */
import type { Leaf, LeafStatus } from './leaves.js';

/** Cap on how much of a branch is described. Beyond this the list stops earning its tokens. */
export const MAX_CONTEXT_LEAVES = 40;

/** How each status reads to the model. Plain words, not the UI's koala vocabulary — "Munching"
 *  means nothing to a model and would burn tokens on a joke it cannot get. */
const STATUS_WORD: Record<LeafStatus, string> = {
  proposed: 'proposed, not yet accepted',
  pending: 'accepted, not started',
  running: 'in progress',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * Builds the system message describing a branch's existing leaves.
 *
 * Returns an empty string when the branch has none, so the caller can append unconditionally and
 * a fresh conversation carries no dead weight.
 *
 * Titles only, never bodies. A body is several sentences and there can be dozens of leaves; the
 * model needs to know what exists and what state it is in, not to re-read every description on
 * every turn.
 */
export function buildLeafContext(leaves: Leaf[]): string {
  if (!leaves.length) return '';

  // Roots first, then depth order, so the shape of the decomposition survives flattening.
  const ordered = [...leaves].sort(
    (a, b) => a.depth - b.depth || a.createdAt.localeCompare(b.createdAt),
  );
  const shown = ordered.slice(0, MAX_CONTEXT_LEAVES);

  const lines = shown.map((leaf) => {
    const indent = '  '.repeat(Math.min(leaf.depth, 3));
    return `${indent}- ${leaf.title} [${STATUS_WORD[leaf.status] ?? leaf.status}]`;
  });

  const omitted = ordered.length - shown.length;
  return [
    'Work already tracked on this branch:',
    ...lines,
    ...(omitted > 0 ? [`  …and ${omitted} more`] : []),
    '',
    'Do not propose work that is already listed. Refer to it by title if it is relevant.',
  ].join('\n');
}
