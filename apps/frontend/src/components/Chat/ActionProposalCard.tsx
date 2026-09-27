import { CheckCircle2, Loader2, Rocket, XCircle } from 'lucide-react'
import type { ActionProposal } from '@koala/harness-types'

export interface ActionProposalCardProps {
  proposal: ActionProposal
  busy: boolean
  error?: string | undefined
  onApply: () => void
  onReject: () => void
}

const STATUS_WORD: Record<ActionProposal['status'], string> = {
  proposed: 'Waiting for you',
  applying: 'Applying…',
  applied: 'Applied',
  rejected: 'Rejected',
  failed: 'It did not go through',
}

export default function ActionProposalCard({ proposal, busy, error, onApply, onReject }: ActionProposalCardProps) {
  const decidable = proposal.status === 'proposed' || proposal.status === 'failed'
  return (
    <div className="w-full p-3 my-2 rounded-md bg-[var(--bark-800)] border border-[var(--bark-700)] text-slate-200 text-xs flex flex-col gap-2" data-testid="action-proposal">
      <div className="flex items-start gap-2">
        <Rocket size={14} className="text-violet-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-100 first-letter:uppercase">{proposal.summary}</div>
          <div className="text-slate-400">{STATUS_WORD[proposal.status]}{proposal.reason ? ` — ${proposal.reason}` : ''}</div>
        </div>
        {proposal.status === 'applying' && <Loader2 size={14} className="animate-spin text-slate-400 shrink-0" />}
        {proposal.status === 'applied' && <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />}
        {proposal.status === 'rejected' && <XCircle size={14} className="text-slate-500 shrink-0" />}
      </div>
      <ul className="ml-1 flex flex-col gap-0.5 text-slate-300">
        {proposal.detail.map((line) => <li key={line} className="font-mono break-all">{line}</li>)}
      </ul>
      {proposal.result && <div className="text-slate-400">{proposal.result}</div>}
      {decidable && (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={onApply} className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 cursor-pointer">
            {proposal.status === 'failed' ? 'Try again' : 'Apply'}
          </button>
          <button type="button" disabled={busy} onClick={onReject} className="px-2 py-1 rounded bg-[var(--bark-700)] hover:bg-[var(--bark-600)] disabled:opacity-50 cursor-pointer">
            Reject
          </button>
        </div>
      )}
      {error && <span className="text-red-400">{error}</span>}
    </div>
  )
}
