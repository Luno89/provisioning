import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccessRequest } from '@koala/harness-types'
import { accessKeys, dismissAccess, grantAccess, listAccessRequests } from '../../../api/cluster-access'
import { errorMessage } from '../../../api/client'

export function useAccessRequests(conversationId: string | null | undefined, streaming = false) {
  const qc = useQueryClient()
  const id = conversationId ?? ''
  const { data: requests = [] } = useQuery<AccessRequest[]>({ queryKey: accessKeys.forConversation(id), queryFn: () => listAccessRequests(id), enabled: Boolean(conversationId) })

  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) void qc.invalidateQueries({ queryKey: accessKeys.all })
    wasStreaming.current = streaming
  }, [streaming, qc])

  const settled = () => { void qc.invalidateQueries({ queryKey: accessKeys.all }) }
  const grant = useMutation({ mutationFn: (requestId: string) => grantAccess(requestId), onSuccess: settled })
  const dismiss = useMutation({ mutationFn: (requestId: string) => dismissAccess(requestId), onSuccess: settled })
  const failed = grant.error ?? dismiss.error

  return {
    requests,
    grant: (requestId: string) => grant.mutate(requestId),
    dismiss: (requestId: string) => dismiss.mutate(requestId),
    busy: grant.isPending || dismiss.isPending,
    error: failed ? errorMessage(failed) || 'That did not go through.' : undefined,
  }
}
