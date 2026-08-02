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

export interface LeafProposal {
  title: string;
  body?: string;
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
  '{"leaves":[{"title":"Short imperative title","body":"What doing this involves"}]}',
  '```',
  '',
  'Rules:',
  '- Propose nothing if the work is still unclear. Ask a question instead.',
  '- One leaf per genuinely separate piece of work. Do not split a single change into steps.',
  '- Titles are imperative and specific: "Add a rate limit to /api/chat", not "Rate limiting".',
  '- Anything you propose is only a suggestion; a human accepts it before it runs.',
].join('\n');

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
      proposals.push({
        title: title.slice(0, MAX_TITLE),
        ...(body ? { body: body.slice(0, MAX_BODY) } : {}),
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
