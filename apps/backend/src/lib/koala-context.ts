/**
 * Keeping a Koala conversation inside the window it has to fit in.
 *
 * ── THE FAILURE THIS EXISTS FOR ──
 * The chat route sent the system prompt plus EVERY message in the thread, forever. There was no
 * trimming of any kind. The only thing standing between a long conversation and the engine was
 * `fittedMaxTokens`, which floors at MIN_TURN_TOKENS — so once the prompt passed the window it
 * stopped reporting a smaller reply budget and simply asked for 600 tokens on top of a prompt that
 * already did not fit. The engine allocates the pair up front and refuses. The result was a
 * conversation that worked, worked, worked, and then permanently stopped working, with no path back
 * except starting again and losing everything that had been agreed.
 *
 * ── WHY A RESET AND NOT A SLIDING WINDOW ──
 * `trimConversation` (sandbox-tools.ts) is the leaf loop's answer and it is right for the leaf loop:
 * it blanks old TOOL output, which is recoverable by running the tool again. Koala's thread is
 * prose. Applied here it finds nothing it is willing to shrink and returns the conversation
 * unchanged — so it is not an option that was rejected, it is one that does not apply. And a plain
 * sliding window is worse than useless for planning: the thing you must never drop is the OLDEST
 * message, because that is what the user actually asked for.
 *
 * So the middle collapses into a written record and the two ends survive.
 *
 * ── WHY THE ARTIFACT IS ASSEMBLED AND NOT SUMMARISED BY A MODEL ──
 * A summary reads better. It is still the wrong call here, for four reasons that are specific to
 * this conversation and not general:
 *
 *   · Koala's durable state is already STRUCTURED and already in the record — `proposedTrees`,
 *     `proposedSpecs`, `title`. Reading those is not an approximation of what a summariser would
 *     produce, it is strictly more accurate, because a summariser would be re-deriving from prose
 *     facts that are sitting in a database column.
 *   · A failed summarisation leaves nothing at the exact moment something is needed. Concatenating
 *     fields that are already loaded has no failure mode.
 *   · It is an 8k-token inference in front of a turn the user is waiting on, arriving unannounced
 *     mid-conversation. The chat already spends real time on tool rounds.
 *   · A pure function gets a test. A summariser gets a mock and a hope.
 *
 * What this loses is the DELIBERATIVE thread — "we considered three approaches and picked Postgres
 * because the cluster already runs one". That is why the tail is kept verbatim rather than folded
 * in, and why `keyDiscoveries` carries what the tools actually returned. If the elided middle turns
 * out to matter, the honest test is whether Koala starts re-asking questions it already asked, and
 * the fix is to add a summarising call HERE, once per reset, persisted onto the notice — roughly
 * one inference per forty turns rather than one per turn. That distinction is the whole argument.
 */
import { contextPressure } from './sampling.js';
import type { Conversation, ConversationMessage, ProposedTree, ProposedSpec } from './conversations.js';

/**
 * Reset well before the cliff, not at it.
 *
 * Two things have to fit AFTER the decision is made: the notice itself, and the reply the user is
 * waiting for. KOALA_MAX_TOKENS is 8,000 — 24% of a 32,768 window on its own — so a prompt sitting
 * at 0.55 plus a full reply is already ~0.79. Resetting at 0.9 would mean the recovery does not fit
 * either, which is the failure mode arriving through its own remedy.
 *
 * It also degrades gently: crossing this early costs one summarised middle, and crossing it late
 * costs the conversation.
 */
export const KOALA_CONTEXT_PRESSURE = 0.55;

/**
 * Messages kept verbatim after the notice.
 *
 * Small on purpose. This is the live thread — what is being discussed right now — and everything
 * older is represented in the artifact. Making it large defeats the reset; making it zero throws
 * away the exchange in progress, which is the one part a summary reads worst.
 */
export const KOALA_HANDOFF_TAIL = 4;

/** Caps on what the artifact may carry, so a reset can never be the thing that blows the window. */
const MAX_GOAL_CHARS = 600;
const MAX_DISCOVERY_CHARS = 160;
const MAX_DISCOVERIES = 8;
const MAX_LISTED_PROPOSALS = 10;

/**
 * Whether this turn should reset before it runs.
 *
 * `incomingChars` is the message about to be appended. Counting it matters: the check happens
 * before the append so the notice lands ahead of the new message without splicing, and being one
 * message out here is the difference between resetting and hard-failing.
 */
export function needsHandoff(promptChars: number, incomingChars: number): boolean {
  return contextPressure(promptChars + incomingChars) >= KOALA_CONTEXT_PRESSURE;
}

/** Where a previous reset ended, or -1. Everything at or before it is already in the artifact. */
function lastHandoffIndex(messages: ConversationMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.handoff) return i;
  }
  return -1;
}

/**
 * The messages a prompt should actually carry.
 *
 * Slices from the most recent handoff notice INCLUSIVE — the notice is the summary of everything
 * above it, so it is the first thing the model reads, not something skipped past. With no notice
 * this is the whole thread, which is the correct behaviour for every conversation that has never
 * grown large enough to need one.
 */
export function historyForPrompt(messages: ConversationMessage[]): ConversationMessage[] {
  const at = lastHandoffIndex(messages);
  return at === -1 ? messages : messages.slice(at);
}

/** What the tools found, in the model's own record of them rather than its account of them. */
function keyDiscoveries(messages: ConversationMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      // Failed calls are dropped: "get_logs returned an error" tells a future turn nothing it
      // cannot find out by calling again, and the room is better spent on what was learned.
      if (!call.ok) continue;
      const digest = call.digest.replace(/\s+/g, ' ').trim().slice(0, MAX_DISCOVERY_CHARS);
      if (digest) out.push(`${call.name} → ${digest}`);
    }
  }
  // Newest first, then capped: a reset at turn 60 has far more of these than can be carried, and
  // the recent ones are the ones the current exchange depends on.
  return out.reverse().slice(0, MAX_DISCOVERIES);
}

function listProposals(
  trees: ProposedTree[] = [],
  specs: ProposedSpec[] = [],
): { open: string[]; accepted: string[] } {
  const open: string[] = [];
  const accepted: string[] = [];

  for (const t of trees.slice(0, MAX_LISTED_PROPOSALS)) {
    const line = `project "${t.name}" (${t.type}) — ${t.goal}`;
    (t.treeId ? accepted : open).push(line);
  }
  for (const s of specs.slice(0, MAX_LISTED_PROPOSALS)) {
    const id = (s.spec as { id?: string } | null)?.id ?? s.id;
    const line = `app spec "${id}"`;
    (s.acceptedAt ? accepted : open).push(line);
  }
  return { open, accepted };
}

/**
 * The handoff artifact, as the notice's own text.
 *
 * Deliberately not a separate field on the conversation. As a message it survives reload for free,
 * it is what the model reads as context it already has (the reason `branch-notice.ts` writes
 * notices in the assistant role), and the elision is visible at the point in the transcript where
 * it actually happened rather than in a panel somewhere else.
 *
 * Enabled MCP servers are deliberately ABSENT. `buildKoalaPrompt` rebuilds that catalogue from
 * `enabledForSession` on every single turn, marking what is already on — so copying it here would
 * create a second source of truth for a fact that already survives resets perfectly.
 */
export function buildHandoffNotice(conversation: Conversation, now = new Date().toISOString()): ConversationMessage {
  const messages = historyForPrompt(conversation.messages);
  const firstUser = messages.find((m) => m.role === 'user' && !m.notice);
  const goal = (firstUser?.content ?? conversation.title).replace(/\s+/g, ' ').trim().slice(0, MAX_GOAL_CHARS);
  const { open, accepted } = listProposals(conversation.proposedTrees, conversation.proposedSpecs);
  const discoveries = keyDiscoveries(messages);

  const lines = [
    'Earlier messages in this conversation were summarised to fit the context window.',
    '',
    '**What this conversation is about**',
    goal || '(not recorded)',
  ];

  if (accepted.length) {
    lines.push('', '**Already accepted — do not propose these again**', ...accepted.map((a) => `- ${a}`));
  }
  if (open.length) {
    lines.push('', '**Proposed and still waiting on the user**', ...open.map((o) => `- ${o}`));
  }
  if (discoveries.length) {
    lines.push('', '**What the tools found**', ...discoveries.map((d) => `- ${d}`));
  }

  lines.push(
    '',
    'Carry on from here. If you need detail that was in the elided messages, call the tool again '
    + 'rather than guessing — the results above are a summary, not the full output.',
  );

  return { role: 'assistant', content: lines.join('\n'), at: now, notice: true, handoff: true };
}

/**
 * Applies the reset: the notice, then the live tail.
 *
 * Returns the messages to STORE. The tail is taken from the post-notice slice so two resets in a
 * row cannot nest — the second one summarises the first notice plus what followed it, and the
 * artifact stays one level deep however long the conversation runs.
 */
export function withHandoff(conversation: Conversation, now = new Date().toISOString()): ConversationMessage[] {
  const notice = buildHandoffNotice(conversation, now);
  const current = historyForPrompt(conversation.messages);
  // Never re-include a previous notice: its content is already folded into the new one.
  const tail = current.filter((m) => !m.handoff).slice(-KOALA_HANDOFF_TAIL);
  const kept = conversation.messages.slice(0, conversation.messages.length - current.length);
  return [...kept, notice, ...tail];
}

/**
 * A cap on the STORED thread, which is a different problem from the prompt.
 *
 * `reasoning` is never sent to the model — `conversationFor` maps only role and content — but it is
 * persisted at up to 20,000 characters per message and shipped to the browser in full on every
 * conversation GET. So a thread can be perfectly comfortable in the window and still be a document
 * nobody wants to load. Mirrors `trimTranscript` in leaves.ts, which caps a branch for the same
 * reason.
 *
 * Kept on the most recent messages only, because that is the thinking anyone is still reading.
 */
export const KOALA_REASONING_KEPT = 6;

export function trimKoalaThread(messages: ConversationMessage[]): ConversationMessage[] {
  const cutoff = messages.length - KOALA_REASONING_KEPT;
  return messages.map((m, i) => {
    if (i >= cutoff || !m.reasoning) return m;
    const { reasoning: _dropped, ...rest } = m;
    return rest;
  });
}
