import type { Branch, Leaf, LeafStatus } from './leaves.js';
import { projectStanding } from './branch-settlement.js';

export const MAX_CONTEXT_LEAVES = 40;

export const MAX_SIBLING_LEAVES = 30;

const STATUS_WORD: Record<LeafStatus, string> = {
  proposed: 'proposed, not yet accepted',
  pending: 'accepted, not started',
  running: 'in progress',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function buildSiblingContext(branches: Branch[], leaves: Leaf[]): string {
  const standing = projectStanding(branches, leaves);
  const sections: string[] = [];

  if (standing.finishedLines.length) {
    sections.push([
      'Finished runs in this project:',
      ...standing.finishedLines.map((line) => (line.startsWith('    ') ? line : `- ${line}`)),
    ].join('\n'));
  }

  if (standing.delivered.length) {
    const shown = standing.delivered.slice(0, MAX_SIBLING_LEAVES);
    const omitted = standing.delivered.length - shown.length;
    sections.push([
      'Already built (do not build these again):',
      ...shown.map((t) => `- ${t}`),
      ...(omitted > 0 ? [`  …and ${omitted} more`] : []),
    ].join('\n'));
  }

  if (standing.outstanding.length) {
    sections.push([
      'Attempted in this project and NOT delivered:',
      ...standing.outstanding.flatMap((o) => [
        `- ${o.title} (from "${o.from}")`,
        `    ${o.evidence}`,
      ]),
      '',
      'If any of these is still wanted, propose it again and say that it is a retry and why it might'
        + ' go differently given the error above. If it is not wanted, say so and leave it alone.',
    ].join('\n'));
  }

  const liveLines = standing.liveBranches.flatMap(({ branch, leaves: theirs }) =>
    theirs
      .filter((l) => l.status === 'running' || l.status === 'pending')
      .map((l) => `- ${l.title} [${STATUS_WORD[l.status] ?? l.status}, in "${branch.title}"]`));
  if (liveLines.length) {
    sections.push([
      'Being worked on right now, in another conversation:',
      ...liveLines.slice(0, MAX_SIBLING_LEAVES),
      '',
      'Do not start any of these.',
    ].join('\n'));
  }

  return sections.join('\n\n');
}

export function buildLeafContext(leaves: Leaf[]): string {
  if (!leaves.length) return '';

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

export interface OutboundMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

export function buildOutboundMessages(opts: {
  messages: OutboundMessage[];
  lastIndex: number;
  prompt?: string | undefined;
  personaPrompt?: string | undefined;
  leaves: Leaf[];
  siblingLeaves?: Leaf[];
  siblingBranches?: Branch[];
  planText?: string | undefined;
  toolPrompt?: string | undefined;
  doneMeans?: string | undefined;
  fileConventions?: string | undefined;
}): OutboundMessage[] {
  const {
    messages, lastIndex, prompt, personaPrompt, leaves, siblingLeaves, siblingBranches, planText, toolPrompt,
    doneMeans, fileConventions,
  } = opts;
  if (!prompt && !toolPrompt && !personaPrompt && !doneMeans && !fileConventions) return messages;

  const context = buildLeafContext(leaves);
  const siblings = buildSiblingContext(siblingBranches ?? [], siblingLeaves ?? []);
  const system: OutboundMessage = {
    role: 'system',
    content: [
      personaPrompt,
      prompt,
      doneMeans ? `This project is a ${doneMeans}` : undefined,
      fileConventions,
      context,
      siblings,
      toolPrompt,
    ].filter(Boolean).join('\n\n'),
  };

  if (planText === undefined) return [system, ...messages];

  const target = messages[lastIndex];
  if (!target) return [system, ...messages];
  return [
    system,
    ...messages.slice(0, lastIndex),
    { ...target, content: planText || 'Propose the work we have been discussing.' },
  ];
}
