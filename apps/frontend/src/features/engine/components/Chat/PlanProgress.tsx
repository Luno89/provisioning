import type { ReactElement } from 'react'
import { CheckCircle2, CircleDashed, Hand, Loader2, XCircle } from 'lucide-react'
import type { PlanProposal } from '@koala/harness-types'
import { errorMessage } from '../../../../api/client'
import type { StoryAddress } from './ChatNotice'
import { usePlanProgress } from '../../hooks/usePlanProgress'
import type { PlanStepState } from './plan-progress'

const ICONS: Record<PlanStepState, ReactElement> = {
  done: <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" />,
  running: <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-slate-400" />,
  waiting: <Hand size={13} className="mt-0.5 shrink-0 text-amber-300" />,
  queued: <CircleDashed size={13} className="mt-0.5 shrink-0 text-slate-500" />,
  failed: <XCircle size={13} className="mt-0.5 shrink-0 text-rose-400" />,
}

export default function PlanProgress({ proposal, onOpenStory }: { proposal: PlanProposal; onOpenStory?: ((story: StoryAddress) => void) | undefined }) {
  const { progress, error } = usePlanProgress(proposal)
  if (error) return <p className="text-rose-300">{errorMessage(error)}</p>
  if (!progress) return null

  return (
    <div className="flex flex-col gap-1" data-testid="plan-progress">
      <ul className="flex flex-col gap-1">
        {progress.steps.map((step) => (
          <li key={step.label} className="flex items-start gap-2">
            {ICONS[step.state]}
            <span className={`flex-1 ${step.state === 'failed' ? 'text-rose-200' : 'text-slate-200'}`}>
              {step.label}{step.detail ? <span className="text-slate-400"> — {step.detail}</span> : null}
            </span>
            {step.story && onOpenStory && (
              <button type="button" onClick={() => onOpenStory(step.story!)} className="shrink-0 text-sky-300 hover:text-sky-200 cursor-pointer">
                {step.state === 'running' ? 'Watch it work ›' : 'Open the story ›'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {progress.ready && (
        <div className="flex items-center gap-2" data-testid="plan-ready">
          {ICONS.done}
          <span className="text-slate-200">{progress.ready}</span>
        </div>
      )}
    </div>
  )
}
