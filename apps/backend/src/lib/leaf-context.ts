/**
 * Tells the model what work already exists — on this conversation, and in the project around it.
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
import type { Branch, Leaf, LeafStatus } from './leaves.js';
import { projectStanding } from './branch-settlement.js';

/** Cap on how much of a branch is described. Beyond this the list stops earning its tokens. */
export const MAX_CONTEXT_LEAVES = 40;

/**
 * Cap on how much of the REST of the project is described.
 *
 * Smaller than the branch's own cap on purpose: this is there to stop the model rebuilding
 * something, which needs only titles and outcomes, whereas its own branch is the thing it is
 * actually working on.
 */
export const MAX_SIBLING_LEAVES = 30;

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
/**
 * Where the project stands, for a conversation working inside it.
 *
 * ── WHY IT IS NOT A LIST OF LEAVES ──
 * The first version dumped every sibling leaf title. That was better than the nothing it replaced,
 * but it made no distinction between a run that FINISHED and one still going, so a failure from
 * last night's run read exactly like something that had just broken — and it grew without bound as
 * the project did.
 *
 * A finished run collapses to one line plus whatever it still owes. Only a live conversation is
 * described leaf by leaf, because that is the one case where the detail changes what this
 * conversation should do next: stay out of its way.
 *
 * ── AND WHY OUTSTANDING WORK IS A QUESTION, NOT A FACT ──
 * Work that was attempted and not delivered is offered as something to DECIDE about, with its
 * attempt count and which run it came from. The planner is the thing that can weigh whether a third
 * attempt is worth making; it just needs to know that it would be a third.
 */
export function buildSiblingContext(branches: Branch[], leaves: Leaf[]): string {
  const standing = projectStanding(branches, leaves);
  const sections: string[] = [];

  if (standing.finishedLines.length) {
    sections.push([
      'Finished runs in this project:',
      // Already indented where a line is a citation under its run.
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

  /**
   * The list that used to be a permanent row in somebody else's branch.
   *
   * Framed as a decision rather than a fact, because that is what it is: the planner is the thing
   * that can weigh whether a third attempt is worth it, and it needs to know it would be a third.
   */
  if (standing.outstanding.length) {
    sections.push([
      'Attempted in this project and NOT delivered:',
      ...standing.outstanding.flatMap((o) => [
        `- ${o.title} (from "${o.from}")`,
        // The reason, not just the count. Deciding whether a third attempt would go differently is
        // impossible without knowing how the second one ended.
        `    ${o.evidence}`,
      ]),
      '',
      'If any of these is still wanted, propose it again and say that it is a retry and why it might'
        + ' go differently given the error above. If it is not wanted, say so and leave it alone.',
    ].join('\n'));
  }

  // A conversation still in flight is described by its leaves: a sibling needs to know what is
  // being worked on RIGHT NOW in order to stay out of its way, and a summary does not exist yet.
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

/** A chat message on the wire. Loose by design — the route passes client messages straight through. */
export interface OutboundMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

/**
 * Builds the message array sent upstream.
 *
 * Extracted from the chat route because the invariant it protects is not obvious and has broken
 * twice: **there may be at most one system message, and it must be first.** Chat templates reject
 * anything else outright — `TemplateError: System message must be at the beginning` — and the
 * failure is total, not degraded, so a branch summary appended as its own message took down every
 * plan and auto turn the moment branches started owning leaves.
 *
 * Chat mode deliberately sends no system message at all: the proposal affordance costs tokens on
 * every turn and biases ordinary conversation toward finding work.
 */
export function buildOutboundMessages(opts: {
  messages: OutboundMessage[];
  /** Index of the turn being sent. Only meaningful for an explicit /plan. */
  lastIndex: number;
  /** The system prompt for this mode, or undefined for chat mode. */
  prompt?: string | undefined;
  /**
   * The chosen persona's prompt — WHO is answering, as opposed to what this turn is for.
   *
   * Composed into the same single system message, first: identity before instructions. It is also
   * the one thing that gives chat mode a system message at all, which is a deliberate exception —
   * chat sends none by default so ordinary conversation is not biased toward finding work, but
   * picking a persona is an explicit request to be answered by someone in particular.
   */
  personaPrompt?: string | undefined;
  /** Leaves already on the branch, summarised into the same system message. */
  leaves: Leaf[];
  /**
   * Leaves on the project's OTHER conversations.
   *
   * Separate from `leaves` because the two say different things: one is what this conversation has
   * going on, the other is what it must not rebuild.
   */
  siblingLeaves?: Leaf[];
  /** The project's other conversations, needed to tell a finished run from one in flight. */
  siblingBranches?: Branch[];
  /** For an explicit /plan: the message with the command stripped off. */
  planText?: string | undefined;
  /**
   * Added whenever tools are offered, in EVERY mode.
   *
   * Chat mode otherwise sends no system message at all, but it still gets tools — and the
   * discipline this carries (never invent a tool result) addresses a failure that happens
   * regardless of mode, so it is the one thing that can bring a system message into being.
   */
  toolPrompt?: string | undefined;
  /**
   * What this KIND of project means by finished, from TREE_TYPES.
   *
   * Eleven types have carried a `doneMeans` since trees were introduced and nothing has ever read
   * one — `api-service` has said "its tests pass, it builds, it deploys, and the endpoint responds"
   * the whole time, while planners wrote whatever acceptance occurred to them. Composing it is what
   * turns a description into a standard the plan is held to.
   */
  doneMeans?: string | undefined;
}): OutboundMessage[] {
  const {
    messages, lastIndex, prompt, personaPrompt, leaves, siblingLeaves, siblingBranches, planText, toolPrompt,
    doneMeans,
  } = opts;
  if (!prompt && !toolPrompt && !personaPrompt && !doneMeans) return messages;

  const context = buildLeafContext(leaves);
  const siblings = buildSiblingContext(siblingBranches ?? [], siblingLeaves ?? []);
  const system: OutboundMessage = {
    role: 'system',
    content: [
      personaPrompt,
      prompt,
      // Before the board, because it is the standard the work is judged against rather than a
      // detail about it.
      doneMeans ? `This project is a ${doneMeans}` : undefined,
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
    // The command itself is stripped: the model should see the request, not the syntax. An empty
    // /plan is meaningful — "plan what we just discussed" — so the prior turns carry it, and a
    // placeholder keeps the final message non-empty.
    { ...target, content: planText || 'Propose the work we have been discussing.' },
  ];
}
