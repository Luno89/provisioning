/* ═══════════════ Unified chat-pack client ═══════════════ */

/**
 * Opens a turn for a persona pack.
 *
 * Calls `POST /api/chat-pack/:packId` with the turn request and returns the SSE response.
 * The caller is responsible for reading and parsing the stream (via lib/parse-sse).
 */
import { postStream, type StreamResponse } from './client.js';

export interface ChatPackTurnRequest {
  packId: string;
  conversationId?: string;
  message: string;
  sessionId?: string;
  modelId?: string;
}

/** Opens the turn and returns the SSE response. */
export const openChatPackStream = (
  body: ChatPackTurnRequest,
  signal?: AbortSignal,
): Promise<StreamResponse> => {
  const { packId, ...rest } = body;
  return postStream(`/chat-pack/${packId}`, rest, signal);
};