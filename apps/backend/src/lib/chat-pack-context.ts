
import { titleFrom } from './conversations.js';
import { trimKoalaThread, withHandoff, needsHandoff } from './koala-context.js';
import { buildKoalaPrompt } from './koala-persona.js';
import type { Conversation } from './conversations.js';
import type { BudgetConfig } from '@koala/harness-types';

export type ChatThread = Conversation;

export function appendUserTurn(
  budget: BudgetConfig,
  thread: ChatThread,
  message: string,
  now: string,
): ChatThread {
  let next = thread;
  if (needsHandoff(budget, JSON.stringify(thread.messages).length, message.length)) {
    next = { ...next, messages: withHandoff(budget, next, now) };
  }
  next = {
    ...next,
    title: next.messages.length === 0 ? titleFrom(message) : next.title,
    messages: trimKoalaThread(budget, [...next.messages, { role: 'user', content: message, at: now }]),
    updatedAt: now,
  };
  return next;
}

export { buildKoalaPrompt };