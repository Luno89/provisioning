/**
 * Structured extraction — turning a conversation into proposed leaves.
 *
 * ── WHY THIS IS A SEPARATE CALL ──
 * Deliberation and structure are different jobs, and the big model is only good at the first.
 * Measured against TabbyAPI serving Qwen3-27B with reasoning on: the same concrete request emitted
 * a usable proposal block roughly ONE TIME IN EIGHT. Not a prompt-wording problem — during 1,600
 * to 7,900 characters of reasoning it repeatedly talked itself into asking a clarifying question
 * instead of proposing. Lowering temperature did not help; `/no_think` does not disable thinking
 * in this deployment; and `json_schema` is accepted but the reasoning still consumes the budget
 * before any content is produced.
 *
 * Reasoning is worth keeping — it is what makes the conversation good. But it turns out the fix is
 * not a second model either: the SAME model, called with thinking disabled for this one request,
 * is a reliable extractor. Measured on the 27B: three runs produced identical, correct output
 * where the reasoning path had managed roughly one success in eight.
 *
 * So the conversation keeps its reasoning and extraction turns it off per-call. A separately
 * configured extractor is still supported, for a model that cannot disable thinking.
 *
 * Kept pure. The prompt and the parsing are the parts that break quietly, and both are testable
 * without a GPU.
 */
import { usableServiceName } from './service-name.js';
import type { LeafProposal } from './plan-mode.js';

/**
 * JSON schema handed to the engine for constrained decoding.
 *
 * TabbyAPI (ExLlamaV3) accepts this and enforces it during sampling, which makes malformed output
 * structurally impossible rather than merely unlikely — the difference between "usually parses"
 * and "always parses". An empty array is explicitly valid: the extractor must be able to say
 * "there is no concrete work here" without violating the schema, or it will invent some.
 */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    leaves: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['title'],
      },
    },
  },
  required: ['leaves'],
} as const;

export const EXTRACTION_SYSTEM_PROMPT = [
  'You extract concrete work items from a conversation. You do not plan, advise, or add ideas.',
  '',
  'Return JSON: {"leaves":[{"title":"...","body":"..."}]}',
  '',
  'Rules:',
  '- Only work the conversation actually settled on. Never invent, extend or improve on it.',
  '- Return {"leaves":[]} if nothing concrete was agreed. This is a correct and common answer.',
  '- Ignore questions, options being weighed, and things explicitly rejected.',
  '- Titles are imperative and specific. Body says what the work involves, in one or two sentences.',
  '- One entry per separately deliverable piece of work — not per step of a single change.',
].join('\n');

/**
 * Chat-template variables sent with an extraction request.
 *
 * `enable_thinking: false` is what makes this work. Qwen3.5+ dropped the `/no_think` soft switch —
 * which is why that did nothing when tried — and moved the control to a template parameter. Passed
 * under `template_vars` specifically: sending `enable_thinking` at the TOP LEVEL also suppressed
 * reasoning but produced garbage output (mid-sentence language switching), so the nesting is not
 * cosmetic.
 *
 * Harmlessly ignored by templates that do not define the variable.
 */
export const EXTRACTION_TEMPLATE_VARS = { enable_thinking: false } as const;

/** Turns fed to the extractor. More context finds plans spread over several turns; more costs latency. */
export const EXTRACTION_TURN_WINDOW = 6;
/** Hard character cap, so one enormous reply cannot blow the extractor's context. */
export const EXTRACTION_CHAR_CAP = 12_000;

export interface ConversationTurn {
  role: string;
  content: string;
}

/**
 * Builds the extractor's user message from recent conversation.
 *
 * Takes the tail rather than the head: a plan is refined as a conversation goes on, and the
 * earliest turns are usually the vaguest. Truncates from the FRONT for the same reason — losing
 * old context is much less damaging than losing the conclusion.
 */
export function buildExtractionPrompt(turns: ConversationTurn[]): string {
  const recent = turns.slice(-EXTRACTION_TURN_WINDOW);
  const rendered = recent
    .filter((t) => t.role !== 'system' && typeof t.content === 'string' && t.content.trim())
    .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.content.trim()}`)
    .join('\n\n');

  const body = rendered.length > EXTRACTION_CHAR_CAP ? rendered.slice(-EXTRACTION_CHAR_CAP) : rendered;
  return `Conversation:\n\n${body}\n\nExtract the concrete work items.`;
}

/**
 * Parses the extractor's reply.
 *
 * Still defensive despite the schema: constrained decoding can be unsupported, silently ignored by
 * an engine, or the model can hit its token limit mid-object. Anything unreadable yields NO
 * proposals — inventing work from a broken parse is the one outcome worse than extracting nothing.
 */
export function parseExtractionResult(reply: string, maxProposals: number): LeafProposal[] {
  if (!reply?.trim()) return [];

  // Constrained output is bare JSON, but a fence appears if the engine ignored the schema.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  const candidate = (fenced?.[1] ?? reply).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }

  const leaves = (parsed as { leaves?: unknown })?.leaves;
  if (!Array.isArray(leaves)) return [];

  const out: LeafProposal[] = [];
  for (const raw of leaves) {
    const title = typeof (raw as any)?.title === 'string' ? (raw as any).title.trim() : '';
    if (!title) continue;
    const body = typeof (raw as any)?.body === 'string' ? (raw as any).body.trim() : '';
    out.push({ title: title.slice(0, 200), ...(body ? { body: body.slice(0, 4000) } : {}) });
    if (out.length >= maxProposals) break;
  }
  return out;
}

/**
 * The service name the planner declared, if it declared one.
 *
 * Read separately from the leaves rather than folded into their return type: every caller of
 * `extractProposals` wants leaves, and widening that shape to carry an occasional string would
 * make each of them handle a field they do not use. Same JSON block, read twice — it is a few
 * hundred bytes.
 *
 * Validated rather than trusted: asked for a short name, a model will sometimes answer with a
 * sentence, and prefixing every tool the service exposes with that is worse than falling back to
 * the tree's own name.
 */
export function extractServiceName(text: string): string | undefined {
  if (!text?.trim()) return undefined;
  // Same shape as parseExtractionResult: bare JSON, or fenced if the engine ignored the schema.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    const parsed = JSON.parse(candidate) as { serviceName?: unknown };
    return usableServiceName(parsed?.serviceName);
  } catch {
    return undefined;
  }
}
