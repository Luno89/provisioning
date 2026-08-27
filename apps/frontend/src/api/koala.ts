import { api, postStream, type StreamResponse } from './client'

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

/**
 * Opens a Koala turn.
 *
 * Its envelope is `{delta}` / `{reasoning}` / `{toolCall}` / `{toolResult}` — Koala's own, NOT the
 * raw provider frames `/api/chat` forwards. Both are pinned by `routes/chat-wire.test.ts`.
 *
 * No AbortSignal: unlike the harness turn there is no stop button here, so nothing owns one.
 */
export const openKoalaStream = (
  body: { conversationId: string; message: string; sessionId?: string },
): Promise<StreamResponse> => postStream('/koala/chat', body)

export const koalaKeys = {
  conversations: () => ['koala-conversations'] as const,
  conversation: (id: string) => ['koala-conversation', id] as const,
}

export const listConversations = <T,>(): Promise<T[]> =>
  api.get<T[]>('/koala/conversations').then((r) => r.data)

export const getConversation = <T,>(id: string): Promise<T> =>
  api.get<T>(`/koala/conversations/${id}`).then((r) => r.data)

export const createConversation = <T,>(): Promise<T> =>
  api.post<T>('/koala/conversations', {}).then((r) => r.data)

export const deleteConversation = (id: string): Promise<void> =>
  api.delete(`/koala/conversations/${id}`).then(() => undefined)

/**
 * Accepting a proposal Koala made, in its two flavours.
 *
 * They are separate endpoints because they create different things: a SPEC becomes a new app type
 * in the catalogue, a PROPOSAL becomes a tree of work. Both return what they created, which the
 * caller needs — accepting a proposal navigates straight into the new tree.
 */
export const acceptSpecProposal = <T,>(conversationId: string, proposalId: string): Promise<T> =>
  api.post<T>(`/koala/conversations/${conversationId}/specs/${proposalId}/accept`, {})
    .then((r) => r.data)

export const acceptTreeProposal = <T,>(conversationId: string, proposalId: string): Promise<T> =>
  api.post<T>(`/koala/conversations/${conversationId}/proposals/${proposalId}/accept`, {})
    .then((r) => r.data)

export const acceptEscalationProposal = <T,>(conversationId: string, proposalId: string): Promise<T> =>
  api.post<T>(`/koala/conversations/${conversationId}/escalations/${proposalId}/accept`, {})
    .then((r) => r.data)

export const denyEscalationProposal = <T,>(conversationId: string, proposalId: string): Promise<T> =>
  api.post<T>(`/koala/conversations/${conversationId}/escalations/${proposalId}/deny`, {})
    .then((r) => r.data)

export const submitSecretRequest = <T,>(conversationId: string, requestId: string, value: string): Promise<T> =>
  api.post<T>(`/koala/conversations/${conversationId}/secrets/${requestId}/submit`, { value })
    .then((r) => r.data)

export const dismissSecretRequest = <T,>(conversationId: string, requestId: string): Promise<T> =>
  api.post<T>(`/koala/conversations/${conversationId}/secrets/${requestId}/dismiss`, {})
    .then((r) => r.data)
