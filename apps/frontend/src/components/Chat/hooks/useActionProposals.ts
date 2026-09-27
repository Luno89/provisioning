import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { ActionProposal } from '@koala/harness-types'
import { actionKeys, applyAction, rejectAction } from '../../../api/actions'
import { errorMessage } from '../../../api/client'

export function useActionProposals(key: QueryKey, list: () => Promise<ActionProposal[]>, enabled: boolean, streaming = false) {
  const qc = useQueryClient()
  const { data: proposals = [] } = useQuery<ActionProposal[]>({ queryKey: key, queryFn: list, enabled })

  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) void qc.invalidateQueries({ queryKey: actionKeys.all })
    wasStreaming.current = streaming
  }, [streaming, qc])

  const settled = () => { void qc.invalidateQueries({ queryKey: actionKeys.all }) }
  const apply = useMutation({ mutationFn: (id: string) => applyAction(id), onSuccess: settled })
  const reject = useMutation({ mutationFn: (id: string) => rejectAction(id), onSuccess: settled })
  const failed = apply.error ?? reject.error

  return {
    proposals,
    apply: (id: string) => apply.mutate(id),
    reject: (id: string) => reject.mutate(id),
    busy: apply.isPending || reject.isPending,
    error: failed ? errorMessage(failed) || 'That did not go through.' : undefined,
  }
}
