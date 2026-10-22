import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PlanProposal } from '@koala/harness-types'
import { approvePlan, listPlans, planKeys, rejectPlan } from '../../projects'
import { groveKeys } from '../../projects'
import { engineKeys } from '../api/engine'

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

  const finished = plans.filter((plan) => plan.status === 'adopted' || plan.status === 'failed').map((plan) => plan.id).join(' ')
  const seenFinished = useRef(finished)
  useEffect(() => {
    if (seenFinished.current !== finished) {
      for (const queryKey of [groveKeys.leaves(), groveKeys.branches(), engineKeys.tasks()]) void qc.invalidateQueries({ queryKey })
    }
    seenFinished.current = finished
  }, [finished, qc])

  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming && conversationId) {
      void qc.invalidateQueries({ queryKey: planKeys.all })
    }
    wasStreaming.current = streaming
  }, [streaming, conversationId, qc])

  const settle = (next: PlanProposal) => {
    qc.setQueryData<PlanProposal[]>(key, (current = []) => current.map((plan) => (plan.id === next.id ? next : plan)))
    void qc.invalidateQueries({ queryKey: planKeys.all })
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
