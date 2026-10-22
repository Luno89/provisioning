import { Link } from '@tanstack/react-router'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { errorMessage } from '../../../../api/client'
import { useActionProgress } from '../../hooks/useActionProgress'

const ICONS = {
  done: <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" />,
  running: <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-slate-400" />,
  failed: <XCircle size={13} className="mt-0.5 shrink-0 text-rose-400" />,
}

export default function ProposalProgress({ id }: { id: string }) {
  const progress = useActionProgress(id, true)
  if (progress.error) return <p className="text-rose-300">{errorMessage(progress.error)}</p>
  const now = progress.data
  if (!now) return null

  const open = now.server && (
    <Link to="/studio/mcp-servers/$id" params={{ id: now.server.id }} className="text-sky-300 hover:text-sky-200">Open {now.server.name} ›</Link>
  )
  if (now.done) {
    return (
      <div className="flex items-center gap-2" data-testid="proposal-ready">
        {ICONS.done}
        <span className="flex-1 text-slate-200">{now.ready}</span>
        {open}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1" data-testid="proposal-progress">
      <ul className="flex flex-col gap-1">
        {now.steps.map((step) => (
          <li key={step.label} className="flex items-start gap-2">
            {ICONS[step.state]}
            <span className={step.state === 'failed' ? 'text-rose-200' : 'text-slate-200'}>
              {step.label}{step.detail ? <span className="text-slate-400"> — {step.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {open}
    </div>
  )
}
