import { useRouter } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { parseHash } from '../lib/route.js';
import { useShellStore } from '../stores/shell.js';
import ChatSurface from './ChatSurface.js';

function useSafeChatParams() {
  const router = useRouter({ warn: false });
  const getParams = (pathname = router?.state?.location?.pathname) => {
    if (pathname) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts[0] === 'chat') return { conversationId: parts[1] };
    }
    const route = parseHash(typeof window !== 'undefined' ? window.location.hash : '');
    return { conversationId: route?.path[0] };
  };

  const [params, setParams] = useState(() => getParams());

  useEffect(() => {
    if (!router?.subscribe) return;
    return router.subscribe('onResolved', (evt: any) => {
      setParams(getParams(evt?.toLocation?.pathname));
    });
  }, [router]);

  return {
    conversationId: params.conversationId,
    navigate: router ? (opts: any) => router.navigate(opts) : null,
  };
}

export default function ChatPage() {
  const { conversationId, navigate } = useSafeChatParams();
  const setView = useShellStore((s) => s.setView);

  const handleOpenTree = (treeId: string) => {
    setView('projects');
    window.location.hash = `#/projects/tree/${treeId}`;
    if (navigate) {
      navigate({ to: '/projects/tree/$treeId', params: { treeId } }).catch(() => {});
    }
  };

  const handleConversationChange = (convId: string | null) => {
    const hash = convId ? `#/chat/${convId}` : '#/chat';
    window.location.hash = hash;
    if (navigate) {
      if (convId) {
        navigate({ to: '/chat/$conversationId', params: { conversationId: convId } }).catch(() => {});
      } else {
        navigate({ to: '/chat' }).catch(() => {});
      }
    }
  };

  return (
    <ChatSurface
      conversationId={conversationId}
      onOpenTree={handleOpenTree}
      onConversationChange={handleConversationChange}
    />
  );
}