import { usableServiceName } from './service-name.js';
import type { LeafProposal } from './plan-mode.js';

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
          persona: { type: 'string' },
          mcp: { type: 'array', items: { type: 'string' } },
          projectId: { type: 'string' },
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
  'Return JSON: {"leaves":[{"title":"...","body":"...","persona":"...","mcp":["server-name"]}]}',
  '',
  'Rules:',
  '- Only work the conversation actually settled on. Never invent, extend or improve on it.',
  '- Return {"leaves":[]} if nothing concrete was agreed. This is a correct and common answer.',
  '- Ignore questions, options being weighed, and things explicitly rejected.',
  '- Titles are imperative and specific. Body says what the work involves, in one or two sentences.',
  '- One entry per separately deliverable piece of work — not per step of a single change.',
  '- Copy `persona`, `mcp` and `projectId` exactly as the conversation gave them. Omit any it did not.',
].join('\n');

export const EXTRACTION_TEMPLATE_VARS = { enable_thinking: false } as const;

export const EXTRACTION_TURN_WINDOW = 6;
export const EXTRACTION_CHAR_CAP = 12_000;

export interface ConversationTurn {
  role: string;
  content: string;
}

export function buildExtractionPrompt(turns: ConversationTurn[]): string {
  const recent = turns.slice(-EXTRACTION_TURN_WINDOW);
  const rendered = recent
    .filter((t) => t.role !== 'system' && typeof t.content === 'string' && t.content.trim())
    .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.content.trim()}`)
    .join('\n\n');

  const body = rendered.length > EXTRACTION_CHAR_CAP ? rendered.slice(-EXTRACTION_CHAR_CAP) : rendered;
  return `Conversation:\n\n${body}\n\nExtract the concrete work items.`;
}

export function parseExtractionResult(reply: string, maxProposals: number): LeafProposal[] {
  if (!reply?.trim()) return [];

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
    const persona = typeof (raw as any)?.persona === 'string' ? (raw as any).persona.trim() : '';
    const mcp = Array.isArray((raw as any)?.mcp)
      ? [...new Set((raw as any).mcp.map((m: unknown) => String(m).trim()).filter(Boolean))].slice(0, 8)
      : [];
    out.push({
      title: title.slice(0, 200),
      ...(body ? { body: body.slice(0, 4000) } : {}),
      ...(persona ? { persona: persona.slice(0, 60) } : {}),
      ...(mcp.length ? { mcp: mcp as string[] } : {}),
      ...(typeof (raw as any)?.projectId === 'string' && (raw as any).projectId.trim()
        ? { projectId: (raw as any).projectId.trim().slice(0, 64) }
        : {}),
    });
    if (out.length >= maxProposals) break;
  }
  return out;
}

export function extractServiceName(text: string): string | undefined {
  if (!text?.trim()) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    const parsed = JSON.parse(candidate) as { serviceName?: unknown };
    return usableServiceName(parsed?.serviceName);
  } catch {
    return undefined;
  }
}
