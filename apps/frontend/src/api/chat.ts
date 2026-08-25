import { postStream, type StreamResponse } from './client'

/**
 * The harness chat turn.
 *
 * ── THE WIRE FORMAT IS THE PROVIDER'S, NOT OURS ──
 * `/api/chat` is a byte-for-byte SSE passthrough: the backend forwards the model provider's own
 * OpenAI frames rather than re-encoding them, so what arrives here is `choices[0].delta` with
 * `content`, `reasoning_content` and `tool_calls` on it. `lib/stream-delta.ts` parses that, and
 * `routes/chat-wire.test.ts` pins it on the backend side.
 *
 * This is deliberately NOT the same shape `api/koala.ts` receives. The two routes speak different
 * protocols on purpose, and the day that stops being true will be a decision, not a drift.
 */

/**
 * What a turn sends.
 *
 * `[key: string]: unknown` is doing real work: the knob panel spreads only the values the user
 * actually MOVED into this body, and which knobs exist is a database record the harness owns —
 * enumerating them here would put a copy of that list in the UI, where it would silently stop
 * matching. The named fields are the ones the component always sends.
 */
export interface ChatTurnRequest {
  messages: { role: string; content: string }[]
  stream: true
  modelId?: string | undefined
  /**
   * Absent for a chat with no branch behind it — `exactOptionalPropertyTypes` makes that a real
   * distinction rather than a formality, and the caller genuinely passes `undefined` here.
   */
  branchId?: string | undefined
  mode?: string | undefined
  /** Omitted rather than sent empty: the route 404s an unknown persona, and '' is not one. */
  personaId?: string | undefined
  [key: string]: unknown
}

/**
 * Opens the turn and hands back the live response.
 *
 * Returns the `Response` rather than the parsed text because the caller renders each token as it
 * lands — and because the caller owns the AbortController: this route aborts the UPSTREAM model
 * mid-stream when the user stops a turn, which is a behaviour the transport cannot decide for it.
 */
export const openChatStream = (
  body: ChatTurnRequest,
  signal?: AbortSignal,
): Promise<StreamResponse> =>
  postStream('/chat', body, signal)
