
import { parseHash } from '../lib/route.js';
import { useShellStore } from '../stores/shell.js';
import ChatSurface from './ChatSurface.js';

export default function ChatPage() {
  const route = parseHash(window.location.hash);
  // General chat always runs as koala — no pack segment in the URL any more.
  const conversationId = route?.path[0];
  const setView = useShellStore((s) => s.setView);

  const handleOpenTree = (treeId: string) => {
    window.location.hash = `#/grove/${treeId}`;
    setView('grove');
  };

  const handleConversationChange = (convId: string | null) => {
    window.location.hash = convId ? `#/chat/${convId}` : '#/chat';
  };

  return (
    <ChatSurface
      conversationId={conversationId}
      onOpenTree={handleOpenTree}
      onConversationChange={handleConversationChange}
    />
  );
}