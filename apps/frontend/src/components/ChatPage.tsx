/* ═══════════════ ChatPage — pack-aware chat entry point ═══════════════ */

/**
 * Renders the unified ChatSurface for a persona pack, reading the packId from the URL hash.
 *
 * Route shape: `#/chat/:packId[/:conversationId]`
 *   - packId: 'koala' | 'researcher' | 'harness' | any registered pack
 *   - conversationId: optional existing conversation to resume
 */
import { parseHash } from '../lib/route.js';
import ChatSurface from './ChatSurface.js';

export default function ChatPage() {
  const route = parseHash(window.location.hash);
  const packId = route?.path[0] ?? 'koala';
  const conversationId = route?.path[1];

  return <ChatSurface packId={packId} {...(conversationId ? { conversationId } : {})} />;
}