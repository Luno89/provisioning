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
import type { Leaf, LeafStatus } from './leaves.js';

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
 * What the rest of the project has already built.
 *
 * ── WHY THIS EXISTS ──
 * The context was scoped to the BRANCH, so a second conversation about the same project started
 * completely blind: it could not see a single thing the first one had built, and the only reason it
 * did not routinely rebuild all of it is that nobody had yet asked it to. Measured on this
 * instance, one tree carried 26 leaves across three conversations and 6.6M tokens of finished work
 * that a new conversation in the same tree knew nothing about.
 *
 * ── WHAT IS AND IS NOT LISTED ──
 * `proposed` is excluded: an unaccepted proposal on another conversation is not work that exists,
 * and treating it as done would block the very work it was proposing. `cancelled` is excluded for
 * the same reason — somebody deliberately stopped it, so it is available again.
 *
 * `failed` IS listed, and marked. Failed work may well be worth another attempt, and the model
 * needs to know it was already tried once — that is the difference between a fresh idea and a
 * second run at something that did not work.
 *
 * Done first, because that is the list that must not be repeated.
 */
export function buildSiblingContext(leaves: Leaf[]): string {
  const relevant = leaves.filter((l) => l.status === 'succeeded' || l.status === 'failed'
    || l.status === 'running' || l.status === 'pending');
  if (!relevant.length) return '';

  const rank = (l: Leaf) => (l.status === 'succeeded' ? 0 : l.status === 'running' ? 1 : l.status === 'pending' ? 2 : 3);
  const ordered = [...relevant].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
  const shown = ordered.slice(0, MAX_SIBLING_LEAVES);
  const omitted = ordered.length - shown.length;

  return [
    'Work in this project, from OTHER conversations:',
    ...shown.map((l) => `- ${l.title} [${STATUS_WORD[l.status] ?? l.status}]`),
    ...(omitted > 0 ? [`  …and ${omitted} more`] : []),
    '',
    'This work already exists. Do not propose building it again. If something above failed and is'
      + ' worth another attempt, say so explicitly rather than proposing it as new.',
  ].join('\n');
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
}): OutboundMessage[] {
  const { messages, lastIndex, prompt, personaPrompt, leaves, siblingLeaves, planText, toolPrompt } = opts;
  if (!prompt && !toolPrompt && !personaPrompt) return messages;

  const context = buildLeafContext(leaves);
  const siblings = buildSiblingContext(siblingLeaves ?? []);
  const system: OutboundMessage = {
    role: 'system',
    content: [personaPrompt, prompt, context, siblings, toolPrompt].filter(Boolean).join('\n\n'),
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
