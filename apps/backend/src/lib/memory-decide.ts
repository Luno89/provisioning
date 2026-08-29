import type { MemoryItem } from './memory-store.js';

export type Decision =
  | { action: 'ADD' }
  | { action: 'UPDATE'; targetId: string }
  | { action: 'DELETE'; targetId: string }
  | { action: 'NOOP' };

export const MAX_NEIGHBOURS = 5;

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
    if (!neighbours.some((m) => m.id === targetId)) return { action: 'NOOP' };
    return { action, targetId };
  }

  return { action: 'ADD' };
}

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
      return target
        ? [{ ...target, invalidAt: now, supersededBy: candidate.id, updatedAt: now }, candidate]
        : [candidate];
    case 'DELETE':
      return target ? [{ ...target, invalidAt: now, updatedAt: now }] : [];
  }
}

export interface AdmitDeps {
  neighbours?: (candidate: MemoryItem) => Promise<MemoryItem[]>;
  ask?: (prompt: string) => Promise<string>;
  now?: () => string;
}

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
