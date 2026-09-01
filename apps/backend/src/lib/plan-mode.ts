export interface LeafProposal {
  title: string;
  body?: string;
  persona?: string;
  mcp?: string[];
  projectId?: string;
}

export const AMBIENT_PROPOSAL_PROMPT = [
  'If you become confident about concrete work that should be done, you may end your reply with:',
  '```json',
  '{"leaves":[{"title":"Imperative title","body":"What it involves","persona":"Persona name"}]}',
  '```',
  'Only when the work is clear. Otherwise just talk, or ask a question.',
].join('\n');

export type ChatMode = 'chat' | 'auto' | 'plan';

export function isChatMode(value: unknown): value is ChatMode {
  return value === 'chat' || value === 'auto' || value === 'plan';
}

export interface ChatCommand {
  command: 'plan' | null;
  text: string;
}

export function parseChatCommand(message: string): ChatCommand {
  const match = /^\s*\/plan\b\s*([\s\S]*)$/i.exec(message ?? '');
  if (!match) return { command: null, text: message ?? '' };
  return { command: 'plan', text: (match[1] ?? '').trim() };
}

const MAX_TITLE = 200;
const MAX_BODY = 4000;
const MAX_PERSONA_NAME = 60;

export function extractProposals(reply: string, maxProposals: number): LeafProposal[] {
  if (!reply) return [];

  const blocks = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1] ?? '');
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
      if (!title) continue;

      const body = typeof (raw as any)?.body === 'string' ? (raw as any).body.trim() : '';
      const persona = typeof (raw as any)?.persona === 'string' ? (raw as any).persona.trim() : '';
      const mcp = Array.isArray((raw as any)?.mcp)
        ? [...new Set((raw as any).mcp.map((m: unknown) => String(m).trim()).filter(Boolean))].slice(0, 8)
        : [];
      const projectId = typeof (raw as any)?.projectId === 'string' ? (raw as any).projectId.trim().slice(0, 64) : '';
      proposals.push({
        title: title.slice(0, MAX_TITLE),
        ...(body ? { body: body.slice(0, MAX_BODY) } : {}),
        ...(persona ? { persona: persona.slice(0, MAX_PERSONA_NAME) } : {}),
        ...(mcp.length ? { mcp: mcp as string[] } : {}),
        ...(projectId ? { projectId } : {}),
      });

      if (proposals.length >= maxProposals) return proposals;
    }
  }

  return proposals;
}

export function stripProposalBlock(reply: string): string {
  return reply.replace(/```(?:json)?\s*[\s\S]*?```/gi, (block) =>
    /"leaves"\s*:/.test(block) ? '' : block,
  ).trim();
}
