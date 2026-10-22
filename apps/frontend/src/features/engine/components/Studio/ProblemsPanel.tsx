import { AlertTriangle, CheckCircle2, CircleAlert, Loader2 } from 'lucide-react'
import type { ProcedureProblem } from '@koala/agent-engine/procedure'

export interface ProblemsPanelProps {
  problems: readonly ProcedureProblem[]
  checking: boolean
  onShow: (problem: ProcedureProblem) => void
}

export default function ProblemsPanel({ problems, checking, onShow }: ProblemsPanelProps) {
  const errors = problems.filter((problem) => problem.severity === 'error')

  return (
    <div className="h-full overflow-y-auto p-2 text-xs">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 px-1 text-[11px] text-slate-400">
        {problems.length === 0 ? (
          <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 size={12} /> Nothing wrong — this procedure can be saved and run.</span>
        ) : (
          <span>{errors.length} {errors.length === 1 ? 'error' : 'errors'}, {problems.length - errors.length} {problems.length - errors.length === 1 ? 'warning' : 'warnings'}{errors.length > 0 ? ' — errors have to be fixed before saving' : ''}</span>
        )}
        {checking && <span className="ml-auto flex items-center gap-1 text-slate-500"><Loader2 size={11} className="animate-spin" /> checking tools and agents</span>}
      </div>
      <ul className="space-y-0.5">
        {problems.map((problem, index) => (
          <li key={index}>
            <button
              type="button"
              onClick={() => onShow(problem)}
              disabled={!problem.node && !problem.group}
              className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-[var(--bark-800)] disabled:cursor-default disabled:hover:bg-transparent"
            >
              {problem.severity === 'error'
                ? <CircleAlert size={12} className="mt-0.5 shrink-0 text-red-400" />
                : <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-400" />}
              <span className="font-mono text-[11px] text-slate-500">
                {[problem.group, problem.node, problem.socket ?? problem.exit].filter(Boolean).join(' › ') || 'procedure'}
              </span>
              <span className="text-slate-300">{problem.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
