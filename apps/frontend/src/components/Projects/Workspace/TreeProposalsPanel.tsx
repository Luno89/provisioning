import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PlanProposal } from '@koala/harness-types'
import PlanProposalCard from '../../Chat/PlanProposalCard.js'
import { approvePlan, listTreePlans, planKeys, rejectPlan } from '../../../api/plans.js'
import { groveKeys } from '../../../api/grove.js'
import { errorMessage } from '../../../api/client.js'
import SecretRequestCard from '../../Chat/SecretRequestCard.js'
import { useSecretRequests } from '../../Chat/hooks/useSecretRequests.js'
import { listTreeSecretRequests, secretRequestKeys } from '../../../api/secret-requests.js'

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

  const secrets = useSecretRequests(secretRequestKeys.forTree(treeId), () => listTreeSecretRequests(treeId), true)
  const waiting = secrets.requests.filter((request) => request.status === 'requested')

  const open = proposals.filter((proposal) => SHOWN.includes(proposal.status))
  if (open.length === 0 && waiting.length === 0) return <div className="px-3 py-2 text-[12px] text-slate-500">No plans waiting.</div>

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
      {waiting.map((request) => (
        <SecretRequestCard
          key={request.id}
          request={request}
          busy={secrets.busy}
          error={secrets.error}
          onSubmit={(value, done) => secrets.submit(request.id, value, done)}
          onDismiss={() => secrets.dismiss(request.id)}
        />
      ))}
      {(approve.error || reject.error) && (
        <span className="px-1 pb-2 text-[12px] text-red-400">{errorMessage(approve.error ?? reject.error) || 'That did not go through.'}</span>
      )}
    </div>
  )
}
