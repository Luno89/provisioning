import { PlanProposalCard } from '../../../engine'
import { useTreeCards } from './useTreeCards.js'
import { errorMessage } from '../../../../api/client.js'
import { SecretRequestCard } from '../../../engine'
import { ActionProposalCard } from '../../../engine'
import { EgressRequestCard } from '../../../engine'

export function TreeProposalsPanel({ treeId, quietWhenEmpty = false }: { treeId: string; quietWhenEmpty?: boolean | undefined }) {
  const { open, approve, reject, secrets, waiting, actions, pending, egress, asking } = useTreeCards(treeId)
  if (open.length === 0 && waiting.length === 0 && pending.length === 0 && asking.length === 0) return quietWhenEmpty ? null : <div className="px-3 py-2 text-[12px] text-slate-500">Nothing waits for you.</div>

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
      {asking.map((request) => (
        <EgressRequestCard
          key={request.id}
          request={request}
          busy={egress.busy}
          error={egress.error}
          onAllow={() => egress.allow(request.id)}
          onDismiss={() => egress.dismiss(request.id)}
        />
      ))}
      {pending.map((proposal) => (
        <ActionProposalCard
          key={proposal.id}
          proposal={proposal}
          busy={actions.busy}
          error={actions.error}
          onApply={() => actions.apply(proposal.id)}
          onReject={() => actions.reject(proposal.id)}
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
