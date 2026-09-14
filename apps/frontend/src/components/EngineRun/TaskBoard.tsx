import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Clock, CircleSlash, Loader2, X } from 'lucide-react'
import { acceptTask, dropTask, engineKeys, listTasks, type EngineTask, type TaskStatus } from '../../api/engine'

const STATUS_STYLE: Record<TaskStatus, string> = {
  proposed: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
  accepted: 'text-sky-300 bg-sky-500/10 border-sky-500/20',
  running: 'text-[var(--leaf)] bg-[var(--leaf-stem)]/10 border-[var(--leaf-stem)]/20',
  done: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
  failed: 'text-red-300 bg-red-500/10 border-red-500/20',
  dropped: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
}

const ORDER: TaskStatus[] = ['proposed', 'running', 'accepted', 'done', 'failed', 'dropped']

export default function TaskBoard() {
  const qc = useQueryClient()

  const { data: tasks = [], isLoading } = useQuery<EngineTask[]>({
    queryKey: engineKeys.tasks(),
    queryFn: listTasks,
    refetchInterval: 3_000,
  })

  const invalidate = () => { void qc.invalidateQueries({ queryKey: engineKeys.tasks() }) }
  const accept = useMutation({ mutationFn: acceptTask, onSuccess: invalidate })
  const drop = useMutation({ mutationFn: dropTask, onSuccess: invalidate })

  if (isLoading) {
    return <p className="text-sm text-slate-500 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading work…</p>
  }

  if (tasks.length === 0) {
    return <p className="text-sm text-slate-500 italic">No work yet. Start a delivery run and it will propose some.</p>
  }

  const sorted = [...tasks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const proposed = sorted.filter((task) => task.status === 'proposed')

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-200">Work</h3>
        {proposed.length > 0 && (
          <span className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">
            {proposed.length} waiting on you
          </span>
        )}
      </div>

      <ul className="space-y-2">
        {sorted.map((task) => (
          <li key={task.id} className="border border-[var(--bark-800)] rounded-md bg-[var(--bark-900)]/40 p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-slate-100">{task.title}</span>
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${STATUS_STYLE[task.status]}`}>
                    {task.status}
                  </span>
                  {task.agent && (
                    <span className="text-[10px] font-mono text-slate-400">{task.agent}</span>
                  )}
                </div>

                {task.intent && <p className="text-xs text-slate-400 mt-1">{task.intent}</p>}

                <p className="text-xs text-slate-500 mt-1">
                  <span className="text-slate-600">done means:</span> {task.doneMeans}
                </p>

                {task.checks?.command && (
                  <p className="text-[11px] font-mono text-slate-500 mt-1">checked by: {task.checks.command}</p>
                )}

                {task.waitingOn.length > 0 && (
                  <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
                    <Clock size={10} />
                    waiting on {task.waitingOn.map((dep) => dep.title).join(', ')}
                  </p>
                )}

                {task.evidence && (
                  <p className="text-[11px] text-slate-400 mt-1 whitespace-pre-wrap">{task.evidence}</p>
                )}
              </div>

              {task.status === 'proposed' && (
                <div className="flex gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => accept.mutate(task.id)}
                    disabled={accept.isPending}
                    className="text-[11px] px-2 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1 disabled:opacity-40"
                  >
                    <Check size={10} /> Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => drop.mutate(task.id)}
                    disabled={drop.isPending}
                    className="text-[11px] px-2 py-1 rounded bg-slate-500/10 text-slate-400 border border-slate-500/20 flex items-center gap-1 disabled:opacity-40"
                  >
                    <X size={10} /> Drop
                  </button>
                </div>
              )}

              {task.status === 'accepted' && !task.ready && (
                <CircleSlash size={12} className="text-slate-500 shrink-0 mt-1" />
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
