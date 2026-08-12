/**
 * Making sure every proposed leaf has someone to do it.
 *
 * ── WHY THIS EXISTS ──
 * A persona now carries the entire environment: the image, the limits, the network, the tools, the
 * budget, where the answer goes. So a leaf with no persona is not a leaf running with defaults — it
 * is a leaf running as nobody, in whatever sandbox the calling code happens to construct. The
 * category-based fallback that used to paper over this is gone, and deliberately: a persona chosen
 * because the work was filed as "research" is a persona nobody picked.
 *
 * That makes assignment the planner's job. This module is what holds it to that: the tool result
 * says when a name matched nothing, the turn is re-asked while any leaf is still unassigned, and
 * what survives that is handed to the user rather than guessed at.
 *
 * ── WHY IT ENDS WITH A PERSON ──
 * Refusing the leaf outright would throw away a decomposition that is probably correct over a field
 * the model forgot. Picking one for it would be the guess this whole change removed. Asking again a
 * few times costs an inference pass and usually works; what does not work goes to someone who can
 * actually decide.
 */
import type { Leaf } from './leaves.js';

/**
 * How many extra turns the planner gets to fix its own omission.
 *
 * Two, because the first re-ask is the one that works when the model simply forgot, and a model
 * that has ignored the instruction twice is not going to be persuaded by a third identical request
 * — it is going to spend another inference pass telling us so.
 */
export const MAX_ASSIGNMENT_ROUNDS = 2;

/** Proposed leaves on this branch with nobody assigned to them. */
export function unassignedLeaves(leaves: Leaf[], branchId: string): Leaf[] {
  return leaves.filter((l) => l.branchId === branchId && l.status === 'proposed' && !l.personaId);
}

/**
 * What to say to the planner when it left work unassigned.
 *
 * Names the leaves and lists the personas with their descriptions, because the failure being
 * corrected is almost always that the model did not know the parameter mattered or did not have the
 * names to hand. Asking it to "try again" without either would be asking it to guess.
 */
export function buildAssignmentPrompt(
  leaves: Pick<Leaf, 'title'>[],
  personas: { name: string; description?: string | undefined }[],
): string {
  return [
    `${leaves.length === 1 ? 'This leaf has' : 'These leaves have'} no persona assigned:`,
    ...leaves.map((l) => `- ${l.title}`),
    '',
    'A persona carries the whole environment the work runs in — its toolchain image, what it may',
    'reach on the network, which tools it can call, how long it gets, and where its output goes.',
    'Work with nobody assigned cannot run.',
    '',
    'Available personas:',
    ...personas.map((p) => `- ${p.name}${p.description ? ` — ${p.description}` : ''}`),
    '',
    'Call revise_leaf for each one above, setting `persona` to the name that fits. Choose from the',
    'list; do not invent a name.',
  ].join('\n');
}

/**
 * The notice left on the branch when the planner would not choose.
 *
 * Written for the person who has to finish the job, so it says what is stuck and what to do rather
 * than reporting that a retry budget was exhausted.
 */
export function buildUnassignedNotice(leaves: Pick<Leaf, 'title'>[]): { text: string } {
  const one = leaves.length === 1;
  const text = [
    `**${one ? 'One piece of work needs' : `${leaves.length} pieces of work need`} a persona.**`,
    '',
    `I could not settle on who should do ${one ? 'this' : 'these'}, and picking for you would mean`,
    'choosing the toolchain, the network access and the time budget on a guess:',
    '',
    ...leaves.map((l) => `- ${l.title}`),
    '',
    `Open ${one ? 'it' : 'them'} and assign a persona, and ${one ? 'it' : 'they'} can start.`,
  ].join('\n');
  // A Notice, like every other thing written onto a branch — so it renders as an event rather than
  // as the assistant claiming to have said it.
  return { text };
}
