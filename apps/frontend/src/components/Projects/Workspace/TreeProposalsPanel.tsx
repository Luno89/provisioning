import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PlanProposal } from '@koala/harness-types'
import PlanProposalCard from '../../Chat/PlanProposalCard.js'
import { approvePlan, listTreePlans, planKeys, rejectPlan } from '../../../api/plans.js'
import { groveKeys } from '../../../api/grove.js'
import { errorMessage } from '../../../api/client.js'

const ADOPTING_POLL_MS = 3_000
const SHOWN: PlanProposal['status'][] = ['proposed', 'adopting', 'failed']

export function TreeProposalsPanel({ treeId }: { treeId: string }) {
  const qc = useQueryClient()
  const { data: proposals = [] } = useQuery({
    queryKey: planKeys.forTree(treeId),
    queryFn: () => listTreePlans(treeId),
    refetchInterval: (query) => (query.state.data?.some((proposal) => proposal.status === 'adopting') ? ADOPTING_POLL_MS : 15_000),
  })

  const settled = () => {
    void qc.invalidateQueries({ queryKey: planKeys.all })
    void qc.invalidateQueries({ queryKey: groveKeys.run(treeId) })
    void qc.invalidateQueries({ queryKey: groveKeys.leaves() })
  }
  const approve = useMutation({ mutationFn: (id: string) => approvePlan(id), onSuccess: settled })
  const reject = useMutation({ mutationFn: ({ id, reason }: { id: string; reason?: string }) => rejectPlan(id, reason), onSuccess: settled })

  const open = proposals.filter((proposal) => SHOWN.includes(proposal.status))
  if (open.length === 0) return <div className="px-3 py-2 text-[12px] text-slate-500">No plans waiting.</div>

  return (
    <div className="px-2 flex flex-col" data-testid="tree-proposals">
      {open.map((proposal) => (
        <PlanProposalCard
          key={proposal.id}
          proposal={proposal}
          deciding={approve.isPending || reject.isPending}
          onApprove={() => approve.mutate(proposal.id)}
          onReject={(reason) => reject.mutate({ id: proposal.id, ...(reason ? { reason } : {}) })}
        />
      ))}
      {(approve.error || reject.error) && (
        <span className="px-1 pb-2 text-[12px] text-red-400">{errorMessage(approve.error ?? reject.error) || 'That did not go through.'}</span>
      )}
    </div>
  )
}
