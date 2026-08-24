/**
 * Separates a reply's prose from the proposal block it may end with.
 *
 * The transcript was showing raw JSON. The block is machinery — the proposals are rendered as
 * leaves in their own right and appear in the tree — so leaving it in shows the same thing twice,
 * once in a form nobody asked to read.
 *
 * The streaming case is the fiddly part. The block arrives character by character, so for a second
 * or two there is an unclosed fence containing half an object. Hiding it only once complete means
 * watching JSON type itself out; hiding every unclosed fence means ordinary code blocks stop
 * streaming, which people like watching. So an unclosed fence is hidden ONLY when it already looks
 * like a proposal block.
 */

export interface DisplayProposal {
  title: string;
  body?: string;
}

export interface SplitReply {
  /** What to show as the assistant's message. */
  prose: string;
  /** Parsed proposals, once the block is complete. */
  proposals: DisplayProposal[];
  /** A proposal block is mid-flight — show an indicator rather than nothing. */
  pending: boolean;
}

/** A fenced block that is a proposal rather than a code sample. */
const PROPOSAL_BLOCK = /```(?:json)?\s*(\{[\s\S]*?"leaves"[\s\S]*?\})\s*```/i;
/** An unclosed fence that has already started emitting one. */
const PARTIAL_PROPOSAL = /```(?:json)?\s*\{[^`]*$/i;

export function splitProposalBlock(text: string): SplitReply {
  if (!text) return { prose: '', proposals: [], pending: false };

  const complete = PROPOSAL_BLOCK.exec(text);
  if (complete) {
    let proposals: DisplayProposal[] = [];
    try {
      const leaves = JSON.parse(complete[1]!)?.leaves;
      if (Array.isArray(leaves)) {
        proposals = (leaves as unknown[])
          // `unknown`, not `any`: this is parsed JSON from a model, so the guard below is the only
          // thing that makes `l.title` safe to read — with `any` the compiler agreed either way.
          .filter((l): l is { title: string; body?: unknown } =>
            typeof (l as { title?: unknown })?.title === 'string' && !!(l as { title: string }).title.trim())
          .map((l) => ({
            title: String(l.title).trim(),
            ...(typeof l?.body === 'string' && l.body.trim() ? { body: String(l.body).trim() } : {}),
          }));
      }
    } catch {
      // Unparseable: fall through with no proposals but still strip it, since raw broken JSON is
      // even less worth showing than valid JSON.
    }
    return { prose: text.replace(complete[0], '').trim(), proposals, pending: false };
  }

  const partial = PARTIAL_PROPOSAL.exec(text);
  // Only hide a partial when it plausibly belongs to a proposal — an unclosed ```ts block should
  // keep streaming, because watching code appear is the point.
  if (partial && /"?leaves"?|^\{?\s*$/.test(partial[0].slice(partial[0].indexOf('{')))) {
    return { prose: text.slice(0, partial.index).trim(), proposals: [], pending: true };
  }

  return { prose: text, proposals: [], pending: false };
}
