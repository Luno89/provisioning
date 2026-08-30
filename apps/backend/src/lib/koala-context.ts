import { contextPressure } from './sampling.js';
import type { BudgetConfig } from '@koala/harness-types';
import type { Conversation, ConversationMessage, ProposedTree, ProposedSpec } from './conversations.js';

export function needsHandoff(
  budget: BudgetConfig,
  promptChars: number,
  incomingChars: number,
): boolean {
  return contextPressure(budget, promptChars + incomingChars) >= budget.handoff.at;
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

function keyDiscoveries(budget: BudgetConfig, messages: ConversationMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      if (!call.ok) continue;
      const digest = call.digest.replace(/\s+/g, ' ').trim().slice(0, budget.handoff.discoveryChars);
      if (digest) out.push(`${call.name} → ${digest}`);
    }
  }
  return out.reverse().slice(0, budget.handoff.discoveries);
}

function listProposals(
  budget: BudgetConfig,
  trees: ProposedTree[] = [],
  specs: ProposedSpec[] = [],
): { open: string[]; accepted: string[] } {
  const open: string[] = [];
  const accepted: string[] = [];

  for (const t of trees.slice(0, budget.handoff.listedProposals)) {
    const line = `project "${t.name}" (${t.type}) — ${t.goal}`;
    (t.treeId ? accepted : open).push(line);
  }
  for (const s of specs.slice(0, budget.handoff.listedProposals)) {
    const id = (s.spec as { id?: string } | null)?.id ?? s.id;
    const line = `app spec "${id}"`;
    (s.acceptedAt ? accepted : open).push(line);
  }
  return { open, accepted };
}

export function buildHandoffNotice(
  budget: BudgetConfig,
  conversation: Conversation,
  now = new Date().toISOString(),
): ConversationMessage {
  const messages = historyForPrompt(conversation.messages);
  const firstUser = messages.find((m) => m.role === 'user' && !m.notice);
  const goal = (firstUser?.content ?? conversation.title).replace(/\s+/g, ' ').trim().slice(0, budget.handoff.goalChars);
  const { open, accepted } = listProposals(budget, conversation.proposedTrees, conversation.proposedSpecs);
  const discoveries = keyDiscoveries(budget, messages);

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

export function withHandoff(
  budget: BudgetConfig,
  conversation: Conversation,
  now = new Date().toISOString(),
): ConversationMessage[] {
  const notice = buildHandoffNotice(budget, conversation, now);
  const current = historyForPrompt(conversation.messages);
  const tail = current.filter((m) => !m.handoff).slice(-budget.handoff.tail);
  const kept = conversation.messages.slice(0, conversation.messages.length - current.length);
  return [...kept, notice, ...tail];
}

export function trimKoalaThread(budget: BudgetConfig, messages: ConversationMessage[]): ConversationMessage[] {
  const cutoff = messages.length - budget.handoff.reasoningKept;
  return messages.map((m, i) => {
    if (i >= cutoff || !m.reasoning) return m;
    const { reasoning: _dropped, ...rest } = m;
    return rest;
  });
}
