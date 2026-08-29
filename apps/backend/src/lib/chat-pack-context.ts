
import { titleFrom } from './conversations.js';
import { trimKoalaThread, withHandoff, needsHandoff } from './koala-context.js';
import { buildKoalaPrompt } from './koala-persona.js';
import type { Conversation } from './conversations.js';

export type ChatThread = Conversation;

export function appendUserTurn(
  thread: ChatThread,
  message: string,
  now: string,
): ChatThread {
  let next = thread;
  if (needsHandoff(JSON.stringify(thread.messages).length, message.length)) {
    next = { ...next, messages: withHandoff(next, now) };
  }
  next = {
    ...next,
    title: next.messages.length === 0 ? titleFrom(message) : next.title,
    messages: trimKoalaThread([...next.messages, { role: 'user', content: message, at: now }]),
    updatedAt: now,
  };
  return next;
}

export { buildKoalaPrompt };