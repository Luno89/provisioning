/* ═══════════════ ChatPage — pack-aware chat entry point ═══════════════ */

/**
 * Renders the unified ChatSurface for a persona pack, reading the packId from the URL hash.
 *
 * Route shape: `#/chat/:packId[/:conversationId]`
 *   - packId: 'koala' | 'researcher' | 'harness' | any registered pack
 *   - conversationId: optional existing conversation to resume
 */
import { parseHash } from '../lib/route.js';
import { useShellStore } from '../stores/shell.js';
import ChatSurface from './ChatSurface.js';

export default function ChatPage() {
  const route = parseHash(window.location.hash);
  const packId = route?.path[0] ?? 'koala';
  const conversationId = route?.path[1];
  const setView = useShellStore((s) => s.setView);

  const handleOpenTree = (treeId: string) => {
    window.location.hash = `#/grove/${treeId}`;
    setView('grove');
  };

  const handleConversationChange = (convId: string | null) => {
    if (convId) {
      window.location.hash = `#/chat/${packId}/${convId}`;
    } else {
      window.location.hash = `#/chat/${packId}`;
    }
  };

  return (
    <ChatSurface
      packId={packId}
      conversationId={conversationId}
      onOpenTree={handleOpenTree}
      onConversationChange={handleConversationChange}
    />
  );
}