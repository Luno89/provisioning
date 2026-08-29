
export interface DisplayProposal {
  title: string;
  body?: string;
}

export interface SplitReply {
  prose: string;
  proposals: DisplayProposal[];
  pending: boolean;
}

const PROPOSAL_BLOCK = /```(?:json)?\s*(\{[\s\S]*?"leaves"[\s\S]*?\})\s*```/i;
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
          .filter((l): l is { title: string; body?: unknown } =>
            typeof (l as { title?: unknown })?.title === 'string' && !!(l as { title: string }).title.trim())
          .map((l) => ({
            title: String(l.title).trim(),
            ...(typeof l?.body === 'string' && l.body.trim() ? { body: String(l.body).trim() } : {}),
          }));
      }
    } catch {
    }
    return { prose: text.replace(complete[0], '').trim(), proposals, pending: false };
  }

  const partial = PARTIAL_PROPOSAL.exec(text);
  if (partial && /"?leaves"?|^\{?\s*$/.test(partial[0].slice(partial[0].indexOf('{')))) {
    return { prose: text.slice(0, partial.index).trim(), proposals: [], pending: true };
  }

  return { prose: text, proposals: [], pending: false };
}
