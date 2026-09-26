import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { McpRequest } from '@koala/harness-types'
import { chatPackKeys } from '../../../api/chat-pack'
import { errorMessage } from '../../../api/client'
import { dismissMcpRequest, enableMcpRequest, listMcpRequests, listMcpServers, mcpKeys, setConversationServers } from '../../../api/mcp'

export function useMcpServers() {
  return useQuery({ queryKey: mcpKeys.servers(), queryFn: listMcpServers })
}

export function useConversationMcp(conversationId: string | null | undefined, streaming = false) {
  const qc = useQueryClient()
  const id = conversationId ?? ''
  const { data: requests = [] } = useQuery<McpRequest[]>({
    queryKey: mcpKeys.requests(id),
    queryFn: () => listMcpRequests(id),
    enabled: Boolean(conversationId),
  })

  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) void qc.invalidateQueries({ queryKey: mcpKeys.all })
    wasStreaming.current = streaming
  }, [streaming, qc])

  const settled = () => {
    void qc.invalidateQueries({ queryKey: mcpKeys.all })
    void qc.invalidateQueries({ queryKey: chatPackKeys.conversations() })
  }
  const enable = useMutation({ mutationFn: (requestId: string) => enableMcpRequest(requestId), onSuccess: settled })
  const dismiss = useMutation({ mutationFn: (requestId: string) => dismissMcpRequest(requestId), onSuccess: settled })
  const choose = useMutation({ mutationFn: (servers: string[]) => setConversationServers(id, servers), onSuccess: settled })
  const failed = enable.error ?? dismiss.error ?? choose.error

  return {
    requests,
    enable: (requestId: string) => enable.mutate(requestId),
    dismiss: (requestId: string) => dismiss.mutate(requestId),
    choose: (servers: string[]) => choose.mutate(servers),
    busy: enable.isPending || dismiss.isPending || choose.isPending,
    error: failed ? errorMessage(failed) || 'That did not go through.' : undefined,
  }
}
