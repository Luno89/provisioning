import { contextPressure } from './sampling.js';
import type { Conversation, ConversationMessage, ProposedTree, ProposedSpec } from './conversations.js';

export const KOALA_CONTEXT_PRESSURE = 0.55;

export const KOALA_HANDOFF_TAIL = 4;

const MAX_GOAL_CHARS = 600;
const MAX_DISCOVERY_CHARS = 160;
const MAX_DISCOVERIES = 8;
const MAX_LISTED_PROPOSALS = 10;

export function needsHandoff(promptChars: number, incomingChars: number): boolean {
  return contextPressure(promptChars + incomingChars) >= KOALA_CONTEXT_PRESSURE;
}

function lastHandoffIndex(messages: ConversationMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.handoff) return i;
  }
  return -1;
}

export function historyForPrompt(messages: ConversationMessage[]): ConversationMessage[] {
  const at = lastHandoffIndex(messages);
  return at === -1 ? messages : messages.slice(at);
}

function keyDiscoveries(messages: ConversationMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      if (!call.ok) continue;
      const digest = call.digest.replace(/\s+/g, ' ').trim().slice(0, MAX_DISCOVERY_CHARS);
      if (digest) out.push(`${call.name} → ${digest}`);
    }
  }
  return out.reverse().slice(0, MAX_DISCOVERIES);
}

function listProposals(
  trees: ProposedTree[] = [],
  specs: ProposedSpec[] = [],
): { open: string[]; accepted: string[] } {
  const open: string[] = [];
  const accepted: string[] = [];

  for (const t of trees.slice(0, MAX_LISTED_PROPOSALS)) {
    const line = `project "${t.name}" (${t.type}) — ${t.goal}`;
    (t.treeId ? accepted : open).push(line);
  }
  for (const s of specs.slice(0, MAX_LISTED_PROPOSALS)) {
    const id = (s.spec as { id?: string } | null)?.id ?? s.id;
    const line = `app spec "${id}"`;
    (s.acceptedAt ? accepted : open).push(line);
  }
  return { open, accepted };
}

export function buildHandoffNotice(conversation: Conversation, now = new Date().toISOString()): ConversationMessage {
  const messages = historyForPrompt(conversation.messages);
  const firstUser = messages.find((m) => m.role === 'user' && !m.notice);
  const goal = (firstUser?.content ?? conversation.title).replace(/\s+/g, ' ').trim().slice(0, MAX_GOAL_CHARS);
  const { open, accepted } = listProposals(conversation.proposedTrees, conversation.proposedSpecs);
  const discoveries = keyDiscoveries(messages);

  const lines = [
    'Earlier messages in this conversation were summarised to fit the context window.',
    '',
    '**What this conversation is about**',
    goal || '(not recorded)',
  ];

  if (accepted.length) {
    lines.push('', '**Already accepted — do not propose these again**', ...accepted.map((a) => `- ${a}`));
  }
  if (open.length) {
    lines.push('', '**Proposed and still waiting on the user**', ...open.map((o) => `- ${o}`));
  }
  if (discoveries.length) {
    lines.push('', '**What the tools found**', ...discoveries.map((d) => `- ${d}`));
  }

  lines.push(
    '',
    'Carry on from here. If you need detail that was in the elided messages, call the tool again '
    + 'rather than guessing — the results above are a summary, not the full output.',
  );

  return { role: 'assistant', content: lines.join('\n'), at: now, notice: true, handoff: true };
}

export function withHandoff(conversation: Conversation, now = new Date().toISOString()): ConversationMessage[] {
  const notice = buildHandoffNotice(conversation, now);
  const current = historyForPrompt(conversation.messages);
  const tail = current.filter((m) => !m.handoff).slice(-KOALA_HANDOFF_TAIL);
  const kept = conversation.messages.slice(0, conversation.messages.length - current.length);
  return [...kept, notice, ...tail];
}

export const KOALA_REASONING_KEPT = 6;

export function trimKoalaThread(messages: ConversationMessage[]): ConversationMessage[] {
  const cutoff = messages.length - KOALA_REASONING_KEPT;
  return messages.map((m, i) => {
    if (i >= cutoff || !m.reasoning) return m;
    const { reasoning: _dropped, ...rest } = m;
    return rest;
  });
}
