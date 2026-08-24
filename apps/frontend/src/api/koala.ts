import { api } from './client'

/**
 * Koala's conversations.
 *
 * ── THE CHAT TURN IS NOT HERE ──
 * `POST /api/koala/chat` streams SSE and is driven by the chat pane's own reader, not axios: it
 * needs the frames as they arrive, and `api.post(...).then(r => r.data)` would resolve once, after
 * the stream closed, with the whole body. Putting it behind this module would look like it worked
 * and stream nothing.
 *
 * Its envelope is `{delta}` / `{reasoning}` / `{toolCall}` / `{toolResult}`, which is NOT what
 * `/api/chat` speaks — see `routes/chat-wire.test.ts`, which pins both.
 */

export const koalaKeys = {
  conversations: () => ['koala-conversations'] as const,
  conversation: (id: string) => ['koala-conversation', id] as const,
}

export const listConversations = () => api.get('/koala/conversations').then((r) => r.data)
export const getConversation = (id: string) =>
  api.get(`/koala/conversations/${id}`).then((r) => r.data)
export const createConversation = (body?: unknown) =>
  api.post('/koala/conversations', body ?? {}).then((r) => r.data)
export const deleteConversation = (id: string) =>
  api.delete(`/koala/conversations/${id}`).then((r) => r.data)
