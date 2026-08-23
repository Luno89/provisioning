/**
 * Deciding what to remember, in place of a human deciding it.
 *
 * ── WHAT THE GATE ACTUALLY DID ──
 * Anything a model concluded went in as `pending_review`, and `buildMemoryContext` excluded those,
 * so nothing reached a future prompt without somebody agreeing to it. The reasoning was sound: an
 * auto-extracted lesson is prompt injection with a friendly name, and a plausible wrong conclusion
 * is worse than no conclusion because it is confidently repeated.
 *
 * What it did in practice, measured on this instance: 143 memories, 124 of them `pending_review`.
 * Nobody drains a queue. The gate was not protecting the bank — it was the reason 87% of what the
 * harness had learned had never once been read, while the 19 that were active were near-duplicate
 * file listings admitted by a rule rather than by a judgement.
 *
 * ── WHAT REPLACES IT ──
 * Not "no gate". A decision, made against what is ALREADY STORED: retrieve the candidate's nearest
 * neighbours and ask whether this is new, refines one, contradicts one, or is already known. That
 * is the question a reviewer would have been answering, and it is the one nothing was asking — the
 * old extractor could not, because `supersede` matched a single hardcoded title.
 *
 * ── WHY A MODEL IS ALLOWED TO DO THIS AND A MODEL WAS NOT ALLOWED TO BEFORE ──
 * Three properties, all enforced below in code rather than requested in the prompt:
 *
 *   1. It can only act on memories it was SHOWN, all of which belong to the same owner. A decision
 *      naming any other id is discarded — the shape `parseJudgeReply` uses for quotes.
 *   2. Nothing is destroyed. DELETE and UPDATE write `invalidAt`; `db.deleteMemory` is not reachable
 *      from here. Every decision is reversible and auditable, so being wrong costs a field.
 *   3. It cannot widen scope. `Decision` has no scope field at all, so promoting a project memory to
 *      global is not a thing the model can express — a wrong project lesson misleads one project, a
 *      wrong global one misleads everything, and that escalation stays the human's.
 */
import type { MemoryItem } from './memory-store.js';

export type Decision =
  /** Genuinely new. Store it. */
  | { action: 'ADD' }
  /** Refines something stored: retire that, store this as its successor. */
  | { action: 'UPDATE'; targetId: string }
  /** Contradicts something stored, and carries no replacement: retire that, store nothing. */
  | { action: 'DELETE'; targetId: string }
  /** Already known, or too thin to be worth carrying. Store nothing. */
  | { action: 'NOOP' };

/** How many neighbours the decision is made against. The spec's number, and a prompt-size limit. */
export const MAX_NEIGHBOURS = 5;

/** Keeps one neighbour from filling the prompt on its own — a layout fact runs to 1,200 chars. */
const NEIGHBOUR_CHARS = 400;

export function buildDecidePrompt(candidate: Pick<MemoryItem, 'title' | 'text' | 'category'>, neighbours: MemoryItem[]): string {
  const stored = neighbours.length
    ? neighbours.map((m) => `id: ${m.id}\ntitle: ${m.title}\ntext: ${m.text.slice(0, NEIGHBOUR_CHARS)}`).join('\n\n')
    : '(nothing similar is stored)';

  return [
    'You maintain an engineering agent\'s memory bank. Decide what to do with one new candidate.',
    '',
    'ALREADY STORED (the most similar entries):',
    stored,
    '',
    'CANDIDATE:',
    `category: ${candidate.category}`,
    `title: ${candidate.title}`,
    `text: ${candidate.text.slice(0, 1_000)}`,
    '',
    'Reply with JSON only, no prose:',
    '  {"action":"ADD"}                    - genuinely new information',
    '  {"action":"UPDATE","id":"<id>"}     - a better version of that stored entry',
    '  {"action":"DELETE","id":"<id>"}     - that stored entry is now wrong, and this is not a replacement',
    '  {"action":"NOOP"}                   - already known, or too vague to be useful later',
    '',
    'Rules:',
    '- `id` must be one of the ids listed above, exactly.',
    '- Prefer NOOP over ADD when unsure. A near-duplicate costs every future prompt; a missing note costs nothing.',
    '- Prefer NOOP for anything that only describes one run rather than something durable about this project.',
  ].join('\n');
}

/**
 * The reply, with everything it is not allowed to say removed.
 *
 * ── WHY GARBAGE MEANS ADD AND NOT NOOP ──
 * The prompt asks the model to prefer NOOP when unsure, and that is about the model's judgement. A
 * reply that does not parse is not a model being unsure — it is the pipeline failing, and the
 * previous behaviour when there was no pipeline at all was to record what the leaf learned. Losing
 * a real lesson because a JSON brace went missing would be a worse outcome than a duplicate, and a
 * duplicate is what consolidation exists to clean up.
 */
export function parseDecision(reply: string, neighbours: MemoryItem[]): Decision {
  const match = reply.match(/\{[\s\S]*?\}/);
  if (!match) return { action: 'ADD' };

  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { action: 'ADD' };
  }

  const action = String(parsed?.action ?? '').toUpperCase();
  if (action === 'NOOP') return { action: 'NOOP' };
  if (action === 'ADD') return { action: 'ADD' };

  if (action === 'UPDATE' || action === 'DELETE') {
    const targetId = String(parsed?.id ?? '');
    /**
     * The id must be one it was shown.
     *
     * A model that names something else has either invented an id or is reasoning about a memory
     * that was never in front of it, and in both cases the safe reading is that it has no opinion
     * about the candidate. NOOP rather than ADD here on purpose: the model believed this was a
     * duplicate of something, and storing it anyway would be ignoring the one thing it said.
     */
    if (!neighbours.some((m) => m.id === targetId)) return { action: 'NOOP' };
    return { action, targetId };
  }

  return { action: 'ADD' };
}

/**
 * The rows a decision produces. Pure, so what a model is able to cause is a thing you can read.
 *
 * Note what is absent: no branch returns a deletion, and no branch alters `scope`, `ownerId` or
 * `projectId` on anything. The candidate is stored as the extractor built it or not at all.
 */
export function applyDecision(
  decision: Decision,
  candidate: MemoryItem,
  neighbours: MemoryItem[],
  now = new Date().toISOString(),
): MemoryItem[] {
  const target = 'targetId' in decision
    ? neighbours.find((m) => m.id === decision.targetId)
    : undefined;

  switch (decision.action) {
    case 'NOOP':
      return [];
    case 'ADD':
      return [candidate];
    case 'UPDATE':
      // Supersession as a new row: the old one keeps its history and points at what replaced it.
      return target
        ? [{ ...target, invalidAt: now, supersededBy: candidate.id, updatedAt: now }, candidate]
        : [candidate];
    case 'DELETE':
      // No successor — the stored entry simply stopped being true, and the candidate was the
      // evidence for that rather than a replacement for it.
      return target ? [{ ...target, invalidAt: now, updatedAt: now }] : [];
  }
}

export interface AdmitDeps {
  /** The candidate's nearest stored neighbours. Absent or throwing means the decision is skipped. */
  neighbours?: (candidate: MemoryItem) => Promise<MemoryItem[]>;
  /** One model turn. Absent means the gate is off, or no endpoint was resolvable. */
  ask?: (prompt: string) => Promise<string>;
  now?: () => string;
}

/**
 * Candidate in, rows to write out.
 *
 * Every failure — no model, no search, a thrown error, a timeout upstream — resolves to ADD, which
 * is exactly what the harness did before this file existed. Admission must never be the reason a
 * leaf's lesson is lost.
 */
export async function admitMemory(
  deps: AdmitDeps,
  candidate: MemoryItem,
): Promise<{ decision: Decision; write: MemoryItem[] }> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  if (!deps.ask || !deps.neighbours) return { decision: { action: 'ADD' }, write: [candidate] };

  try {
    const neighbours = (await deps.neighbours(candidate)).slice(0, MAX_NEIGHBOURS);
    const decision = parseDecision(await deps.ask(buildDecidePrompt(candidate, neighbours)), neighbours);
    return { decision, write: applyDecision(decision, candidate, neighbours, now) };
  } catch (err) {
    console.warn(`[MemoryDecide] admitting "${candidate.title}" without a decision: ${(err as Error).message}`);
    return { decision: { action: 'ADD' }, write: [candidate] };
  }
}
