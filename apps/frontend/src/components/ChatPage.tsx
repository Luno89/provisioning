
import { useState, useEffect } from 'react';
import { parseHash } from '../lib/route.js';
import { useShellStore } from '../stores/shell.js';
import ChatSurface from './ChatSurface.js';

export default function ChatPage() {
  const route = parseHash(window.location.hash);
  const initialPackId = route?.path[0] ?? 'koala';
  const conversationId = route?.path[1];
  const setView = useShellStore((s) => s.setView);

  const [packId, setPackId] = useState(initialPackId);

  useEffect(() => {
    const r = parseHash(window.location.hash);
    const p = r?.path[0] ?? 'koala';
    if (p !== packId) setPackId(p);
  }, [packId]);

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
      onPackChange={(id) => {
        setPackId(id);
        window.location.hash = conversationId
          ? `#/chat/${id}/${conversationId}`
          : `#/chat/${id}`;
      }}
    />
  );
}