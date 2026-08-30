import type { WorkspaceImageSpec } from './workspace-image-seeds.js';

import { describeSandbox } from './workspace-spec.js';

export interface LeafProposal {
  title: string;
  body?: string;
  persona?: string;
  mcp?: string[];
  projectId?: string;
}

export const planSystemPrompt = (images: readonly WorkspaceImageSpec[]): string => [
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
  '- `serviceName` is optional and only for work that produces a service other agents will call.',
  '  Short, lowercase, one or two words, no version — `weather`, `github-api`. It becomes the prefix',
  '  on every tool the service exposes, so a long or generic one makes them hard to tell apart.',
  '- `persona` is REQUIRED on every leaf. Use a name from the personas listed for you, exactly as',
  '  written. A persona decides the toolchain, what the work may reach, and how long it may run —',
  '  a leaf with no persona, or with a name that is not real, cannot be started by anyone.',
  '- Before proposing work that needs a capability, call list_mcp_servers to see what is already',
  '  running. Servers deployed here are real and their tools are callable from a leaf, so prefer',
  '  using one over rebuilding it. When the work BUILDS a server, propose a final leaf that calls',
  '  its tools for real — a server nothing has ever called is not known to work.',
  '- Call set_acceptance once, for the request as a whole. Per-leaf checks prove each piece; only',
  '  this proves the finished thing works. For a service, that means RUNNING it and calling it for',
  '  real, not just running the test suite.',
  '  Write the checks as a SEQUENCE: install dependencies, then build or test, then run the thing.',
  '  A check that runs the product without installing it first fails on a missing package and',
  '  proves nothing about the product.',
  '- End the plan with a leaf that exercises the FINISHED thing the way a user would: call the',
  '  deployed service, run the entry point, open the artefact. Name what it must produce in',
  '  `expects`, so its success is a file that exists rather than a claim.',
  '- When this project depends on a service (anything you declared with add_project_dependency), a',
  '  sandbox CANNOT verify the connection — bindings exist only in the deployed service. That final',
  '  leaf must call the DEPLOYED thing instead: name the service in its `mcp` so it can call its',
  '  tools for real, and check the response is what a user would get.',
  '  Do the same whenever the assembled result could fail in ways the individual pieces cannot.',
  '- Propose nothing if the work is still unclear. Ask a question instead.',
  '- One leaf per genuinely separate piece of work. Do not split a single change into steps.',
  '- Never propose the same work twice under different wording. Naming the file in one title and',
  '  the action in another still describes one leaf.',
  '- Titles are imperative and specific: "Add a rate limit to /api/chat", not "Rate limiting".',
  '- Anything you propose is only a suggestion; a human accepts it before it runs.',
  '- Each leaf is carried out later by an agent in the sandbox described below. Do not propose work',
  '  that environment cannot do.',
  '',
  describeSandbox(images),
].join('\n');

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

export const PLAN_MODE_MAX_TOKENS = 8000;

export const MAX_PROPOSALS_PER_REPLY = 8;

const MAX_TITLE = 200;
const MAX_BODY = 4000;
const MAX_PERSONA_NAME = 60;

export function extractProposals(reply: string): LeafProposal[] {
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

      if (proposals.length >= MAX_PROPOSALS_PER_REPLY) return proposals;
    }
  }

  return proposals;
}

export function stripProposalBlock(reply: string): string {
  return reply.replace(/```(?:json)?\s*[\s\S]*?```/gi, (block) =>
    /"leaves"\s*:/.test(block) ? '' : block,
  ).trim();
}
