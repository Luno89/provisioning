import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PlanProposal } from '@koala/harness-types'
import { approvePlan, listPlans, planKeys, rejectPlan } from '../../../api/plans'

const ADOPTING_POLL_MS = 2_000

export function usePlanProposals(conversationId: string | null | undefined, streaming: boolean) {
  const qc = useQueryClient()
  const key = planKeys.forConversation(conversationId ?? '')

  const { data: plans = [] } = useQuery<PlanProposal[]>({
    queryKey: key,
    queryFn: () => listPlans(conversationId!),
    enabled: Boolean(conversationId),
    refetchInterval: (query) => (query.state.data?.some((plan) => plan.status === 'adopting') ? ADOPTING_POLL_MS : false),
  })

  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming && conversationId) {
      void qc.invalidateQueries({ queryKey: planKeys.forConversation(conversationId) })
    }
    wasStreaming.current = streaming
  }, [streaming, conversationId, qc])

  const settle = (next: PlanProposal) => {
    qc.setQueryData<PlanProposal[]>(key, (current = []) => current.map((plan) => (plan.id === next.id ? next : plan)))
  }

  const approve = useMutation({ mutationFn: (id: string) => approvePlan(id), onSuccess: settle })
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => rejectPlan(id, reason),
    onSuccess: settle,
  })

  return {
    plans,
    approve: (id: string) => approve.mutate(id),
    reject: (id: string, reason?: string) => reject.mutate({ id, ...(reason ? { reason } : {}) }),
    deciding: approve.isPending || reject.isPending,
    error: approve.error ?? reject.error,
  }
}
