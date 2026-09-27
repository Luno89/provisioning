import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { EgressRequest } from '@koala/harness-types'
import { allowEgress, dismissEgress, egressKeys } from '../../../api/egress'
import { errorMessage } from '../../../api/client'

export function useEgressRequests(key: QueryKey, list: () => Promise<EgressRequest[]>, enabled: boolean, streaming = false) {
  const qc = useQueryClient()
  const { data: requests = [] } = useQuery<EgressRequest[]>({ queryKey: key, queryFn: list, enabled })

  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) void qc.invalidateQueries({ queryKey: egressKeys.all })
    wasStreaming.current = streaming
  }, [streaming, qc])

  const settled = () => { void qc.invalidateQueries({ queryKey: egressKeys.all }) }
  const allow = useMutation({ mutationFn: (id: string) => allowEgress(id), onSuccess: settled })
  const dismiss = useMutation({ mutationFn: (id: string) => dismissEgress(id), onSuccess: settled })
  const failed = allow.error ?? dismiss.error

  return {
    requests,
    allow: (id: string) => allow.mutate(id),
    dismiss: (id: string) => dismiss.mutate(id),
    busy: allow.isPending || dismiss.isPending,
    error: failed ? errorMessage(failed) || 'That did not go through.' : undefined,
  }
}
