import type { Leaf } from './leaves.js';

export const MAX_ASSIGNMENT_ROUNDS = 2;

export function unassignedLeaves(leaves: Leaf[], branchId: string): Leaf[] {
  return leaves.filter((l) => l.branchId === branchId && l.status === 'proposed' && !l.packId);
}

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
  return { text };
}
