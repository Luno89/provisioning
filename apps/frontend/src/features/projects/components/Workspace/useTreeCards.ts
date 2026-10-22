import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PlanProposal } from '@koala/harness-types'
import { approvePlan, listTreePlans, planKeys, rejectPlan } from '../../api/plans.js'
import { groveKeys } from '../../api/grove.js'
import { useSecretRequests } from '../../../engine'
import { listTreeSecretRequests, secretRequestKeys } from '../../api/secret-requests.js'
import { useActionProposals } from '../../../engine'
import { actionKeys, listTreeActions } from '../../../engine'
import { useEgressRequests } from '../../../engine'
import { egressKeys, listEgressRequests } from '../../../infrastructure'

const ADOPTING_POLL_MS = 3_000
const SHOWN: PlanProposal['status'][] = ['proposed', 'adopting', 'failed']

export function useTreeCards(treeId: string) {
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
  const approve = useMutation({ mutationFn: (id: string) => approvePlan(id), onSuccess: settled, onError: settled })
  const reject = useMutation({ mutationFn: ({ id, reason }: { id: string; reason?: string }) => rejectPlan(id, reason), onSuccess: settled })

  const secrets = useSecretRequests(secretRequestKeys.forTree(treeId), () => listTreeSecretRequests(treeId), true)
  const waiting = secrets.requests.filter((request) => request.status === 'requested')
  const actions = useActionProposals(actionKeys.forTree(treeId), () => listTreeActions(treeId), true)
  const egress = useEgressRequests(egressKeys.requests('tree', treeId), () => listEgressRequests('treeId', treeId), true)
  const asking = egress.requests.filter((request) => request.status === 'requested')
  const pending = actions.proposals.filter((proposal) => proposal.status === 'proposed' || proposal.status === 'applying' || proposal.status === 'failed')
  const open = proposals.filter((proposal) => SHOWN.includes(proposal.status))
  const count = open.filter((proposal) => proposal.status !== 'adopting').length + waiting.length + pending.filter((proposal) => proposal.status !== 'applying').length + asking.length

  return { open, approve, reject, secrets, waiting, actions, pending, egress, asking, count }
}
