import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import ChatSurface from '../../ChatSurface'
import KoalaLoading from '../../../shared/components/KoalaLoading'
import type { StoryAddress } from '../../Chat/ChatNotice'
import { itemChatKeys, openItemChat, type ChatItemKind } from '../../../api/item-chats'
import { errorMessage } from '../../../api/client'

export function ItemChat({ kind, id, intro, onOpenTree, onOpenStory }: {
  kind: ChatItemKind
  id: string
  intro: ReactNode
  onOpenTree?: ((treeId: string) => void) | undefined
  onOpenStory?: ((story: StoryAddress) => void) | undefined
}) {
  const chat = useQuery({ queryKey: itemChatKeys.of(kind, id), queryFn: () => openItemChat(kind, id), staleTime: Infinity })
  if (chat.isLoading) return <KoalaLoading label="Opening its chat…" />
  if (chat.isError || !chat.data) return <p className="p-3 text-[12px] text-rose-300">{errorMessage(chat.error)}</p>
  return (
    <div className="h-full min-h-0" data-testid="item-chat">
      <ChatSurface key={chat.data.id} conversationId={chat.data.id} hideSidebar pinned intro={intro} onOpenTree={onOpenTree} onOpenStory={onOpenStory} />
    </div>
  )
}

export default ItemChat
