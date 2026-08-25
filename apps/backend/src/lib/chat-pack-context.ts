/* ═══════════════ chat-pack/context — koala vault: thread + reset policy ═══════════════ */

/**
 * The conversation vault policy, extracted from the persona-pack router so it is testable alone:
 *   - append a user turn with the "title from first message" rule
 *   - the context-pressure reset (handoff) before the turn does not fit
 *
 * This is EXACTLY the policy the koala route used. Extracting it is a pure refactor: behavior
 * unchanged, but each piece is now independently testable.
 */
import { titleFrom } from './conversations.js';
import { trimKoalaThread, withHandoff, needsHandoff } from './koala-context.js';
import { buildKoalaPrompt } from './koala-persona.js';
import type { Conversation } from './conversations.js';

/** The thread a turn runs on. Alias to Conversation so the router holds one type. */
export type ChatThread = Conversation;

/**
 * Append the user's message, apply the context reset if the thread is at pressure, and set the
 * title from the first message. Returns the UPDATED thread (immutable).
 */
export function appendUserTurn(
  thread: ChatThread,
  message: string,
  now: string,
): ChatThread {
  // Refuse-then-fit: if this turn would push the prompt past the handoff threshold, reset first.
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

/**
 * Build the system prompt for this persona + its currently-enabled services.
 *
 * Re-exported koala composer — the router uses this one name instead of importing koala-persona
 * directly, keeping the vault policy in one place.
 */
export { buildKoalaPrompt };