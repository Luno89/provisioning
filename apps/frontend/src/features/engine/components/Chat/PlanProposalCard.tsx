import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, ClipboardList, Loader2, XCircle } from 'lucide-react'
import type { PlanProposal } from '@koala/harness-types'
import { ItemChangeDetails } from './ItemChangeDetails'
import PlanProgress from './PlanProgress'
import { planHeading } from './chat-cards'
import { groveKeys, listTreeTypes } from '../../../projects'
import { versionLabel } from '../../../projects'
import type { StoryAddress } from './ChatNotice'

export interface PlanProposalCardProps {
  proposal: PlanProposal
  deciding: boolean
  onApprove: () => void
  onReject: (reason?: string) => void
  onOpenTree?: ((treeId: string) => void) | undefined
  onOpenStory?: ((story: StoryAddress) => void) | undefined
  decides?: boolean | undefined
  waiting?: string | undefined
}

const STATUS_WORD: Record<PlanProposal['status'], string> = {
  proposed: 'Waiting for your approval',
  superseded: 'Replaced by a newer plan',
  adopting: 'Building the tree, its sandbox and the plan documents…',
  adopted: 'Adopted',
  rejected: 'Rejected',
  failed: 'Building it failed',
}

const CHANGE_STATUS_WORD: Record<PlanProposal['status'], string> = {
  proposed: 'Waiting for your approval',
  superseded: 'Replaced by a newer change',
  adopting: 'Applying the change and updating the plan documents…',
  adopted: 'Applied',
  rejected: 'Rejected',
  failed: 'Applying it failed',
}

const OUT_OF_DATE = 'out of date: '

function statusLine(proposal: PlanProposal, change: boolean): string {
  if (proposal.status === 'superseded' && proposal.reason?.startsWith(OUT_OF_DATE)) return `Out of date: ${proposal.reason.slice(OUT_OF_DATE.length)}. Nothing was changed.`
  const word = change ? CHANGE_STATUS_WORD[proposal.status] : STATUS_WORD[proposal.status]
  return `${word}${proposal.reason ? ` — ${proposal.reason}` : ''}`
}

export default function PlanProposalCard({ proposal, deciding, onApprove, onReject, onOpenTree, onOpenStory, decides = true, waiting }: PlanProposalCardProps) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [showDoc, setShowDoc] = useState(false)
  const { plan, leafPlan, change, status } = proposal
  const where = planHeading(proposal)
  const newTree = plan?.tree
  const treeTypes = useQuery({ queryKey: groveKeys.treeTypes(), queryFn: listTreeTypes, staleTime: Infinity, enabled: Boolean(newTree) })
  const defaultVersion = treeTypes.data?.find((type) => type.id === newTree?.type)?.versions?.default
  const version = newTree ? versionLabel({ type: newTree.type, version: newTree.version ?? defaultVersion }, treeTypes.data ?? []) : undefined
  const open = status === 'proposed' || status === 'failed'
  const decidable = open && decides && !waiting

  return (
    <div className="w-full p-3 my-2 rounded-md bg-[var(--bark-800)] border border-[var(--bark-700)] text-slate-200 text-xs flex flex-col gap-2" data-testid="plan-proposal">
      <div className="flex items-start gap-2">
        <ClipboardList size={14} className="text-emerald-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-100">{where}{version && <span className="ml-2 text-[11px] px-1.5 rounded bg-[var(--bark-900)] text-slate-300" data-testid="plan-version">{version}</span>}</div>
          <div className="text-slate-400">{statusLine(proposal, Boolean(change))}</div>
        </div>
        {status === 'adopting' && <Loader2 size={14} className="animate-spin text-slate-400 shrink-0" />}
        {status === 'adopted' && <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />}
        {status === 'rejected' && <XCircle size={14} className="text-slate-500 shrink-0" />}
      </div>

      {change && <ItemChangeDetails change={change} decided={!open} />}

      {leafPlan && (
        <>
          <div className="text-slate-300"><span className="text-slate-500">Why: </span>{leafPlan.why}</div>
          {leafPlan.body && <div className="text-slate-300"><span className="text-slate-500">New goal: </span>{leafPlan.body}</div>}
          <button type="button" onClick={() => setShowDoc((open) => !open)} className="self-start text-slate-400 hover:text-slate-200 underline cursor-pointer">
            {showDoc ? 'Hide the brief' : 'Read the brief'}
          </button>
          {showDoc && <pre className="whitespace-pre-wrap font-sans text-slate-300 bg-[var(--bark-900)]/60 rounded p-2 max-h-72 overflow-y-auto">{leafPlan.brief}</pre>}
          <ul className="ml-3 text-slate-400 list-disc list-inside">
            {leafPlan.tasks.map((task) => (
              <li key={task.key}>{task.title} <span className="text-slate-500">— done means: {task.doneMeans}</span></li>
            ))}
          </ul>
        </>
      )}

      {plan?.tree && (plan.tree.release || plan.tree.startsFrom) && (
        <div className="space-y-0.5 text-slate-300" data-testid="plan-project-choices">
          {plan.tree.release && (
            <div><span className="text-slate-500">Released: </span>by <span className="font-mono">{plan.tree.release.agent}</span>{plan.tree.release.app ? <> with the <span className="font-mono">{plan.tree.release.app}</span> adapter</> : null}</div>
          )}
          {plan.tree.startsFrom === 'client-database' && (
            <div><span className="text-slate-500">Starts from the client&apos;s database: </span>its first release waits until you upload their backup on the project&apos;s Settings.</div>
          )}
        </div>
      )}

      {plan?.tree?.serviceName && (
        <div className="text-slate-300" data-testid="plan-service">
          <span className="text-slate-500">Service: </span><span className="font-mono">{plan.tree.serviceName}</span>
          {plan.tree.joins && (
            <div className="text-amber-300">
              {plan.tree.joins.projectId
                ? `This name already belongs to “${plan.tree.joins.treeName}”, so approving puts this work into that service's existing repository.`
                : `“${plan.tree.joins.treeName}” already uses this name; two services sharing a name share their tool prefix.`}
            </div>
          )}
        </div>
      )}

      {plan && (
      <>
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
      </>
      )}

      {open && waiting && <p className="self-end text-[11px] text-amber-200" data-testid="plan-waiting">{waiting}</p>}
      {open && !decides && !waiting && <p className="self-end text-[11px] text-slate-400">An owner or a collaborator decides this.</p>}
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
            {change ? 'Reject change' : 'Reject plan'}
          </button>
        </div>
      )}
      {status === 'adopted' && <PlanProgress proposal={proposal} onOpenStory={onOpenStory} />}
      {status === 'adopted' && proposal.adopted && onOpenTree && !change && (
        <button type="button" onClick={() => onOpenTree(proposal.adopted!.treeId)} className="self-end px-2.5 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white cursor-pointer">
          Open the tree
        </button>
      )}
    </div>
  )
}
