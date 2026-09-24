import { useState } from 'react'
import { CheckCircle2, ClipboardList, Loader2, XCircle } from 'lucide-react'
import type { PlanProposal } from '@koala/harness-types'

export interface PlanProposalCardProps {
  proposal: PlanProposal
  deciding: boolean
  onApprove: () => void
  onReject: (reason?: string) => void
  onOpenTree?: ((treeId: string) => void) | undefined
}

const STATUS_WORD: Record<PlanProposal['status'], string> = {
  proposed: 'Waiting for your approval',
  superseded: 'Replaced by a newer plan below',
  adopting: 'Building the tree, its sandbox and the plan documents…',
  adopted: 'Adopted',
  rejected: 'Rejected',
  failed: 'Building it failed',
}

export default function PlanProposalCard({ proposal, deciding, onApprove, onReject, onOpenTree }: PlanProposalCardProps) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [showDoc, setShowDoc] = useState(false)
  const { plan, status } = proposal
  const where = plan.tree ? `New ${plan.tree.type} tree “${plan.tree.name}”` : 'Grows the current tree'
  const decidable = status === 'proposed' || status === 'failed'

  return (
    <div className="w-full p-3 my-2 rounded-md bg-[var(--bark-800)] border border-[var(--bark-700)] text-slate-200 text-xs flex flex-col gap-2" data-testid="plan-proposal">
      <div className="flex items-start gap-2">
        <ClipboardList size={14} className="text-emerald-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-100">{where}</div>
          <div className="text-slate-400">{STATUS_WORD[status]}{proposal.reason ? ` — ${proposal.reason}` : ''}</div>
        </div>
        {status === 'adopting' && <Loader2 size={14} className="animate-spin text-slate-400 shrink-0" />}
        {status === 'adopted' && <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />}
        {status === 'rejected' && <XCircle size={14} className="text-slate-500 shrink-0" />}
      </div>

      <button type="button" onClick={() => setShowDoc((open) => !open)} className="self-start text-slate-400 hover:text-slate-200 underline cursor-pointer">
        {showDoc ? 'Hide PLAN.md' : 'Read PLAN.md'}
      </button>
      {showDoc && <pre className="whitespace-pre-wrap font-sans text-slate-300 bg-[var(--bark-900)]/60 rounded p-2 max-h-72 overflow-y-auto">{plan.planDoc}</pre>}

      <ul className="flex flex-col gap-1.5">
        {plan.branches.map((branch) => (
          <li key={branch.title}>
            <div className="text-slate-300 font-medium">{branch.title}</div>
            <ul className="ml-3 mt-0.5 flex flex-col gap-1">
              {branch.leaves.map((leaf) => (
                <li key={leaf.key}>
                  <span className="text-slate-200">{leaf.title}</span>
                  <span className="text-slate-500"> — {leaf.body}</span>
                  {leaf.dependsOn.length > 0 && <span className="text-slate-500"> (after {leaf.dependsOn.join(', ')})</span>}
                  {leaf.tasks.length > 0 ? (
                    <ul className="ml-3 text-slate-400 list-disc list-inside">
                      {leaf.tasks.map((task) => (
                        <li key={task.key}>{task.title} <span className="text-slate-500">— done means: {task.doneMeans}</span></li>
                      ))}
                    </ul>
                  ) : (
                    <div className="ml-3 text-slate-500">No tasks yet — planned, not broken down.</div>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      {decidable && !rejecting && (
        <div className="flex items-center gap-1.5 self-end">
          <button type="button" onClick={() => setRejecting(true)} disabled={deciding} className="px-2.5 py-1 rounded bg-[var(--bark-700)] hover:bg-[var(--bark-600)] cursor-pointer disabled:opacity-50">
            Reject
          </button>
          <button type="button" onClick={onApprove} disabled={deciding} className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-50">
            {status === 'failed' ? 'Try again' : 'Approve'}
          </button>
        </div>
      )}
      {decidable && rejecting && (
        <div className="flex items-center gap-1.5">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="What should change? (optional)"
            className="flex-1 px-2 py-1 rounded bg-[var(--bark-900)] border border-[var(--bark-700)] text-slate-200"
          />
          <button type="button" onClick={() => setRejecting(false)} className="px-2 py-1 rounded hover:bg-[var(--bark-700)] cursor-pointer">Back</button>
          <button type="button" onClick={() => onReject(reason.trim() || undefined)} disabled={deciding} className="px-2.5 py-1 rounded bg-red-700 hover:bg-red-600 text-white cursor-pointer disabled:opacity-50">
            Reject plan
          </button>
        </div>
      )}
      {status === 'adopted' && proposal.adopted && onOpenTree && (
        <button type="button" onClick={() => onOpenTree(proposal.adopted!.treeId)} className="self-end px-2.5 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white cursor-pointer">
          Open the tree
        </button>
      )}
    </div>
  )
}
