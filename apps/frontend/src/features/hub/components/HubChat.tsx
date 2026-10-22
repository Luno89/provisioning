import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errorMessage } from '../../../api/client'
import { getHubConversation, hubKeys, postHubMessage, sendHubRequest } from '../api'
import { channelAsksKoala, goesToKoala, rememberChannelAsks } from '../../projects'
import type { HubBoardView, HubChat as HubChatRecord } from '../types'
import { ChatComposer } from '../../engine'
import { ChatMessageRow } from '../../engine'
import { ChatNotice } from '../../engine'
import { PlanProposalCard } from '../../engine'
import { chatFor, HUB_CHAT_EVERY_MS } from '../lib/hub-chat'
import { waitingOn } from '../../projects'
import type { BoardChat, HubPlace } from '../../projects'

function useOpenedChat(projectId: string, chat: BoardChat, found: HubChatRecord | undefined) {
  const client = useQueryClient()
  const asked = useRef(new Set<string>())
  const open = useMutation({
    mutationFn: (item: { item: 'story' | 'feature'; id: string }) => sendHubRequest(projectId, 'open-chat', item),
    onSuccess: () => client.invalidateQueries({ queryKey: hubKeys.board(projectId) }),
  })
  useEffect(() => {
    if (found || chat.kind === 'channel') return
    const key = `${chat.kind}:${chat.id}`
    if (asked.current.has(key)) return
    asked.current.add(key)
    open.mutate({ item: chat.kind, id: chat.id })
  }, [found, chat, open])
  return open
}

export default function HubChat({ projectId, chat, view, hub, me }: { projectId: string; chat: BoardChat; view: HubBoardView; hub: HubPlace; me: string }) {
  const client = useQueryClient()
  const found = chatFor(view, chat)
  const opening = useOpenedChat(projectId, chat, found)
  const conversationId = found?.id
  const conversation = useQuery({
    queryKey: hubKeys.conversation(projectId, conversationId ?? ''),
    queryFn: () => getHubConversation(projectId, conversationId!),
    enabled: Boolean(conversationId),
    refetchInterval: HUB_CHAT_EVERY_MS,
    retry: false,
  })
  const collaborator = view.role === 'collaborator'
  const [asking, setAsking] = useState(() => (conversationId ? channelAsksKoala(conversationId) : false))
  const [askingIn, setAskingIn] = useState(conversationId)
  if (askingIn !== conversationId) {
    setAskingIn(conversationId)
    if (conversationId) setAsking(channelAsksKoala(conversationId))
  }
  const [notAsked, setNotAsked] = useState<string | undefined>(undefined)
  const decides = view.can.includes('approve-changes')

  const post = useMutation({
    mutationFn: (content: string) => postHubMessage(projectId, conversationId!, {
      content,
      ...(chat.kind === 'channel' && !collaborator ? { askKoala: goesToKoala(content, asking) } : {}),
    }),
    onSuccess: async (posted) => {
      setNotAsked(posted.notAsked)
      await client.invalidateQueries({ queryKey: hubKeys.conversation(projectId, conversationId!) })
    },
  })
  const decide = useMutation({
    mutationFn: (request: { kind: 'approve-plan' | 'reject-plan'; proposalId: string; reason?: string | undefined }) =>
      sendHubRequest(projectId, request.kind, { proposalId: request.proposalId, ...(request.reason ? { reason: request.reason } : {}) }),
    onSuccess: () => client.invalidateQueries({ queryKey: hubKeys.board(projectId) }),
  })

  const proposals = useMemo(
    () => view.board.planProposals.filter((proposal) => proposal.conversationId === conversationId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    [view.board.planProposals, conversationId],
  )

  const toggle = () => {
    const next = !asking
    setAsking(next)
    if (conversationId) rememberChannelAsks(conversationId, next)
  }

  if (!conversationId) {
    return (
      <div className="flex h-full flex-col" data-testid="hub-chat">
        <p className="p-3 text-[12px] text-slate-400">{chat.kind === 'channel' ? 'The channel is not on the hub yet.' : 'Opening the chat…'}</p>
        {opening.isError && <p role="alert" className="px-3 text-[12px] text-red-300">{errorMessage(opening.error)}</p>}
      </div>
    )
  }

  const messages = conversation.data?.messages ?? []
  const live = conversation.data?.liveTurn
  const failure = post.error ?? decide.error ?? (conversation.isError ? conversation.error : undefined)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="hub-chat">
      {!view.online && (
        <p className="border-b border-[var(--bark-700)] px-3 py-1.5 text-[11px] text-amber-200" data-testid="hub-offline-chat">
          The owner's instance is offline; your messages are kept and Koala answers when it is back.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {messages.map((message, index) => message.role === 'notice' && message.notice
          ? <ChatNotice key={`${message.at ?? ''}-${index}`} notice={message.notice} at={message.at} onItsPage />
          : <ChatMessageRow key={`${message.at ?? ''}-${index}`} message={message} />)}
        {live && <p className="py-3 text-[12px] italic text-slate-400" data-testid="hub-live-turn">Koala is answering…</p>}
        {proposals.map((proposal) => (
          <div key={proposal.id} className="my-3">
            <PlanProposalCard
              proposal={proposal}
              deciding={decide.isPending}
              decides={decides}
              waiting={waitingOn(hub, ['approve-plan', 'reject-plan'], 'proposalId', proposal.id)}
              onApprove={() => decide.mutate({ kind: 'approve-plan', proposalId: proposal.id })}
              onReject={(reason) => decide.mutate({ kind: 'reject-plan', proposalId: proposal.id, reason })}
            />
          </div>
        ))}
      </div>
      {notAsked && <p className="px-3 py-1 text-[11px] text-slate-400" data-testid="hub-not-asked">{notAsked}</p>}
      {failure && <p role="alert" className="px-3 py-1 text-[12px] text-red-300">{errorMessage(failure)}</p>}
      {chat.kind === 'channel' && collaborator && (
        <p className="px-3 py-1 text-[11px] text-slate-500">Koala answers you from your own instance once it is linked. Until then your messages are posted for everyone.</p>
      )}
      <div className="shrink-0 border-t border-[var(--bark-700)] p-2">
        <ChatComposer
          onSend={(text) => post.mutate(text)}
          onStop={() => undefined}
          isStreaming={false}
          placeholder={chat.kind === 'channel' ? `Message the channel as ${me}` : 'Message this chat'}
          {...(chat.kind === 'channel' && !collaborator ? { channelAsk: { on: asking, onToggle: toggle } } : {})}
        />
      </div>
    </div>
  )
}
