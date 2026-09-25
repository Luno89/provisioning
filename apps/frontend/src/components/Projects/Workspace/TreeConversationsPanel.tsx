import { useQuery } from '@tanstack/react-query'
import { MessageSquare, Plus } from 'lucide-react'
import { chatPackKeys, listChatConversations } from '../../../api/chat-pack.js'
import type { SelectedEntity } from './shared.js'

export function TreeConversationsPanel({
  treeId, selected, onSelect, onNew, creating,
}: {
  treeId: string
  selected: SelectedEntity
  onSelect: (conversationId: string) => void
  onNew: () => void
  creating?: boolean
}) {
  const { data: conversations = [] } = useQuery({
    queryKey: chatPackKeys.conversations(),
    queryFn: listChatConversations,
    refetchInterval: 15_000,
  })
  const mine = conversations.filter((conversation) => conversation.treeId === treeId)

  return (
    <div className="p-2" data-testid="tree-conversations">
      {mine.length === 0 && <div className="px-1 py-1 text-[12px] text-slate-500">No conversations about this tree yet.</div>}
      {mine.map((conversation) => {
        const isSelected = selected.kind === 'conversation' && selected.id === conversation.id
        return (
          <button
            key={conversation.id}
            type="button"
            onClick={() => onSelect(conversation.id)}
            className={`w-full flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer text-[12px] text-left ${isSelected ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-300 hover:bg-[var(--bark-800)]'}`}
          >
            <MessageSquare size={12} className="text-slate-500 shrink-0" />
            <span className="truncate flex-1 min-w-0">{conversation.title}</span>
          </button>
        )
      })}
      <button
        type="button"
        onClick={onNew}
        disabled={creating}
        className="mt-1 flex items-center gap-1.5 py-1 px-2 rounded-md text-[12px] text-slate-500 hover:text-slate-200 hover:bg-[var(--bark-800)] cursor-pointer disabled:opacity-50"
      >
        <Plus size={12} /> New conversation
      </button>
    </div>
  )
}
