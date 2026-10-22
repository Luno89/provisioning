import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { autoModeKeys, listAutoModeAgents, setAgentAutoMode, setConversationAutoMode, setTreeAutoMode } from '../../api/auto-mode'
import { chatPackKeys, type ChatConversation } from '../../api/chat-pack'
import { groveKeys, listTrees } from '../../features/projects'

export interface AutoModeState {
  on: boolean | undefined
  switching: boolean
  error: unknown
  turn: (on: boolean) => void
}

export function useAgentAutoMode(slug: string): AutoModeState {
  const client = useQueryClient()
  const agents = useQuery({ queryKey: autoModeKeys.agents(), queryFn: listAutoModeAgents })
  const turn = useMutation({
    mutationFn: (on: boolean) => setAgentAutoMode(slug, on),
    onSuccess: (next) => client.setQueryData(autoModeKeys.agents(), next),
  })
  return { on: agents.data?.includes(slug), switching: turn.isPending, error: turn.error ?? agents.error, turn: (on) => turn.mutate(on) }
}

export function useTreeAutoMode(treeId: string): AutoModeState {
  const client = useQueryClient()
  const trees = useQuery({ queryKey: groveKeys.trees(), queryFn: listTrees })
  const turn = useMutation({
    mutationFn: (on: boolean) => setTreeAutoMode(treeId, on),
    onSuccess: () => client.invalidateQueries({ queryKey: groveKeys.trees() }),
  })
  const tree = trees.data?.find((entry) => entry.id === treeId)
  return { on: tree ? tree.autoMode === true : undefined, switching: turn.isPending, error: turn.error ?? trees.error, turn: (on) => turn.mutate(on) }
}

export interface ChatAutoModeState extends AutoModeState {
  turnTo: (on: boolean) => Promise<void>
}

export function useConversationAutoMode(conversationId: string | null | undefined, conversation: Pick<ChatConversation, 'autoMode'> | null | undefined): ChatAutoModeState {
  const client = useQueryClient()
  const turn = useMutation({
    mutationFn: (on: boolean) => setConversationAutoMode(conversationId!, on),
    onSuccess: (on) => {
      if (!conversationId) return
      client.setQueryData(chatPackKeys.conversation(conversationId), (was: ChatConversation | undefined) => (was ? { ...was, autoMode: on } : was))
    },
  })
  const on = !conversationId ? undefined : turn.isPending ? turn.variables : conversation?.autoMode === true
  return {
    on,
    switching: turn.isPending,
    error: turn.error,
    turn: (next) => { if (conversationId) turn.mutate(next) },
    turnTo: async (next) => { if (conversationId) await turn.mutateAsync(next) },
  }
}
