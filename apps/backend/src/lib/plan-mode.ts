/**
 * Plan mode — turning a planning conversation into proposed leaves.
 *
 * A branch IS the conversation. In plan mode the model is asked to put forward work as it goes,
 * and anything it proposes lands as a `proposed` leaf: no workflow, no spend, waiting for a human.
 *
 * ── PARSING MODEL OUTPUT IS THE FRAGILE PART ──
 * This is free-form text from a local model, not a function-calling API, so it is parsed
 * defensively and pessimistically: anything unrecognised yields NO proposals rather than a guess.
 * A wrong proposal is worse than none — it puts words in the user's plan that the model did not
 * quite say, and the whole point of the proposed status is that a human reviews before work starts.
 *
 * Kept pure so the parser can be tested against the shapes models actually emit — fenced blocks
 * with language tags, prose wrapped around JSON, trailing commentary — without a model in the loop.
 */

import { describeSandbox } from './workspace-spec.js';

export interface LeafProposal {
  title: string;
  body?: string;
  /**
   * The NAME of the persona that should do this work, as the model wrote it — resolved to an id by
   * the caller, against that user's own personas.
   *
   * ── WHY THE PROSE PATH NEEDED THIS ──
   * It did not carry one, and could not: the shape was `{title, body}` and the advertised schema
   * asked for nothing else. `propose_leaf` has taken a persona name all along, so a plan made with
   * tools came out assigned and a plan written as prose came out with nobody on it — and a leaf
   * with no persona cannot be accepted at all, because a persona carries the whole environment.
   *
   * That was invisible while prose-only plans went through a follow-up turn that assigned them. The
   * moment one reply MIXED both paths, that turn had already watched itself assign personas via
   * tools, answered the follow-up in prose, and the four prose leaves stayed unassigned. Asking for
   * the persona in the block removes the round-trip instead of making it more reliable.
   */
  persona?: string;
}

/**
 * Appended as a system message in plan mode.
 *
 * Asks for a fenced block because that is the one structure small local models reliably produce,
 * and because it survives the prose they tend to wrap around it. It also explicitly permits
 * proposing nothing, so ordinary discussion inside a planning conversation does not manufacture
 * work — without that, models invent a task to satisfy the format.
 */
export const PLAN_SYSTEM_PROMPT = [
  'You are helping plan a piece of work. Discuss it naturally.',
  '',
  'When — and only when — you are confident about concrete work that should be done, propose it by',
  'ending your reply with a fenced json block:',
  '',
  '```json',
  '{"leaves":[{"title":"Short imperative title","body":"What doing this involves",',
  '            "persona":"Name of the persona that should do it"}],',
  ' "serviceName":"short-name"}',
  '```',
  '',
  'Rules:',
  /**
   * The planner names the service because it is the only thing that knows what is being built.
   *
   * Without it the name fell back to the request id the deployment carries, so every tool the
   * service exposed was prefixed `koala-request-42784df9__` — the one part of the name that should
   * say what the thing IS said nothing at all. Optional: the tree's name is a good fallback, and a
   * sentence offered here is rejected in favour of it.
   */
  '- `serviceName` is optional and only for work that produces a service other agents will call.',
  '  Short, lowercase, one or two words, no version — `weather`, `github-api`. It becomes the prefix',
  '  on every tool the service exposes, so a long or generic one makes them hard to tell apart.',
  /**
   * Stated as required, and as a consequence rather than a rule, because "cannot be started"
   * is the part that makes a model fill the field. Listing available names matters as much: an
   * invented persona resolves to nobody, which is the same stuck leaf by a different route.
   */
  '- `persona` is REQUIRED on every leaf. Use a name from the personas listed for you, exactly as',
  '  written. A persona decides the toolchain, what the work may reach, and how long it may run —',
  '  a leaf with no persona, or with a name that is not real, cannot be started by anyone.',
  /**
   * Having the tool is not the same as using it. Without this the planner proposes building a
   * capability without ever asking whether it is already deployed — which is how the same server
   * gets built twice, and why a server built last week never gets used by anything.
   */
  '- Before proposing work that needs a capability, call list_mcp_servers to see what is already',
  '  running. Servers deployed here are real and their tools are callable from a leaf, so prefer',
  '  using one over rebuilding it. When the work BUILDS a server, propose a final leaf that calls',
  '  its tools for real — a server nothing has ever called is not known to work.',
  '- Propose nothing if the work is still unclear. Ask a question instead.',
  '- One leaf per genuinely separate piece of work. Do not split a single change into steps.',
  /**
   * Aimed at the observed duplicate: the same stage proposed twice, once naming the artefact and
   * once naming the act. Cheaper to prevent in the prompt than to detect afterwards — lexical
   * similarity ranks that pair BELOW two leaves that must both exist (see lib/proposal-merge.ts).
   */
  '- Never propose the same work twice under different wording. Naming the file in one title and',
  '  the action in another still describes one leaf.',
  '- Titles are imperative and specific: "Add a rate limit to /api/chat", not "Rate limiting".',
  '- Anything you propose is only a suggestion; a human accepts it before it runs.',
  '- Each leaf is carried out later by an agent in the sandbox described below. Do not propose work',
  '  that environment cannot do.',
  '',
  // The planner is the one deciding what the work IS, so it needs the constraints more than the
  // executor does — an executor handed an impossible leaf can only fail it.
  describeSandbox(),
].join('\n');

/**
 * The always-on affordance, included in every reply's system prompt.
 *
 * There is no plan MODE. Proposing is an ability the model always has and exercises when it is
 * confident — which is what a skill is, and avoids a toggle that persists and gets forgotten while
 * a conversation drifts between chatting and planning.
 *
 * Deliberately terse. This rides on every message, so length is a per-request cost (mitigated but
 * not erased by prefix caching) and a long instruction biases ordinary chat toward manufacturing
 * work. The full PLAN_SYSTEM_PROMPT is reserved for an explicit /plan.
 *
 * Safe to leave always on because it was MEASURED, not assumed: against TabbyAPI serving Qwen3, a
 * greeting, a general opinion question, a factual question and a vague complaint all correctly
 * produced no proposals, while a concrete request produced exactly one.
 */
export const AMBIENT_PROPOSAL_PROMPT = [
  'If you become confident about concrete work that should be done, you may end your reply with:',
  '```json',
  '{"leaves":[{"title":"Imperative title","body":"What it involves","persona":"Persona name"}]}',
  '```',
  'Only when the work is clear. Otherwise just talk, or ask a question.',
].join('\n');

/**
 * How a conversation treats proposals.
 *
 * Three states rather than a toggle, because a toggle forced a choice between two things neither
 * of which was "leave me alone":
 *
 *   chat — nothing is extracted and no affordance is added. Zero extra cost, zero side effects.
 *   auto — extraction runs after every reply. RELIABLE, unlike the earlier ambient approach which
 *          hoped the conversation model would emit a block and managed roughly one in eight. The
 *          cost is one extra inference call per message.
 *   plan — as auto, plus the conversation model is actively asked to plan and given a larger
 *          budget for the reasoning that provokes.
 *
 * `/plan` in a message forces plan behaviour for that turn regardless of mode, so an explicit
 * request never depends on what the selector happens to be set to.
 */
export type ChatMode = 'chat' | 'auto' | 'plan';

export function isChatMode(value: unknown): value is ChatMode {
  return value === 'chat' || value === 'auto' || value === 'plan';
}

/** Parsed out of a message so an explicit request never depends on the model noticing. */
export interface ChatCommand {
  command: 'plan' | null;
  /** The message with the command stripped. */
  text: string;
}

/**
 * Recognises a leading slash command.
 *
 * Client-side intent, not a model judgement: `/plan` must work even when ambient proposing would
 * have declined, which is the entire reason it exists. Anything else is left untouched — an
 * unknown slash command is far more likely to be someone typing a path than inventing syntax.
 */
export function parseChatCommand(message: string): ChatCommand {
  const match = /^\s*\/plan\b\s*([\s\S]*)$/i.exec(message ?? '');
  if (!match) return { command: null, text: message ?? '' };
  return { command: 'plan', text: (match[1] ?? '').trim() };
}

/**
 * Default completion budget for plan mode, when the caller does not set one.
 *
 * Deliberately large. Measured against the live TabbyAPI deployment serving Qwen3: a single
 * "propose the work" turn produced 7,908 characters of REASONING before 1,210 characters of
 * answer — 2,012 completion tokens in total. At a typical 900-token cap the model never reached
 * its reply at all, and the failure was silent: an empty response, no proposals, no error.
 *
 * Reasoning models spend most of a turn thinking, and plan mode asks for exactly the kind of
 * deliberation that provokes it.
 */
export const PLAN_MODE_MAX_TOKENS = 3000;

/** Hard ceiling on one reply, so a runaway model cannot flood a branch in a single turn. */
export const MAX_PROPOSALS_PER_REPLY = 8;

/** Longest title/body kept. Anything past this is truncated rather than rejected. */
const MAX_TITLE = 200;
const MAX_BODY = 4000;
/** Matches the persona-name limit personas are validated against, so a real name always fits. */
const MAX_PERSONA_NAME = 60;

/**
 * Extracts leaf proposals from a model reply.
 *
 * Returns an empty array for anything it cannot confidently read — no proposals is always a valid
 * outcome, so there is never a reason to guess.
 */
export function extractProposals(reply: string): LeafProposal[] {
  if (!reply) return [];

  // Scan every fenced block rather than just the last: models sometimes emit an illustrative block
  // mid-reply and the real one at the end, and sometimes the reverse.
  const blocks = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1] ?? '');
  // A bare object with no fence is common enough from smaller models to be worth one attempt.
  if (blocks.length === 0) {
    const bare = /\{[\s\S]*"leaves"[\s\S]*\}/.exec(reply);
    if (bare) blocks.push(bare[0]);
  }

  const proposals: LeafProposal[] = [];
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue; // Prose, a code sample, or truncated output — not a proposal.
    }

    const leaves = (parsed as { leaves?: unknown })?.leaves;
    if (!Array.isArray(leaves)) continue;

    for (const raw of leaves) {
      const title = typeof (raw as any)?.title === 'string' ? (raw as any).title.trim() : '';
      // A proposal with no title is unusable — it would render as an empty leaf nobody can judge.
      if (!title) continue;

      const body = typeof (raw as any)?.body === 'string' ? (raw as any).body.trim() : '';
      // Carried as the model wrote it. Resolving a name to an id needs the user's personas, which
      // a pure parser has no business reaching for — the caller does it.
      const persona = typeof (raw as any)?.persona === 'string' ? (raw as any).persona.trim() : '';
      proposals.push({
        title: title.slice(0, MAX_TITLE),
        ...(body ? { body: body.slice(0, MAX_BODY) } : {}),
        ...(persona ? { persona: persona.slice(0, MAX_PERSONA_NAME) } : {}),
      });

      if (proposals.length >= MAX_PROPOSALS_PER_REPLY) return proposals;
    }
  }

  return proposals;
}

/**
 * Strips the proposal block out of the reply shown in the chat.
 *
 * The proposals are rendered as leaves in their own right, so leaving the raw JSON in the
 * transcript shows the same thing twice — once as machinery the user did not ask to see.
 */
export function stripProposalBlock(reply: string): string {
  return reply.replace(/```(?:json)?\s*[\s\S]*?```/gi, (block) =>
    /"leaves"\s*:/.test(block) ? '' : block,
  ).trim();
}
