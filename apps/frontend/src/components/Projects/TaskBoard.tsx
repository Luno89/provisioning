import { useState } from 'react'
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

const FINISHED: TaskStatus[] = ['done', 'failed', 'dropped']

export default function TaskBoard() {
  const qc = useQueryClient()
  const [showFinished, setShowFinished] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)

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

  if (tasks.length === 0) return null

  const sorted = [...tasks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const proposed = sorted.filter((task) => task.status === 'proposed')
  const finished = sorted.filter((task) => FINISHED.includes(task.status))
  const shown = showFinished ? sorted : sorted.filter((task) => !FINISHED.includes(task.status))

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-200">Tasks</h3>
        {proposed.length > 0 && (
          <span className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">
            {proposed.length} waiting on you
          </span>
        )}
        {finished.length > 0 && (
          <button type="button" onClick={() => setShowFinished(!showFinished)} className="ml-auto text-[11px] text-slate-400 hover:text-slate-200">
            {showFinished ? 'Hide finished' : `Show ${finished.length} finished`}
          </button>
        )}
      </div>
      {shown.length === 0 && <p className="text-xs text-slate-500">Nothing is waiting or under way.</p>}

      <ul className="max-h-80 divide-y divide-[var(--bark-800)] overflow-y-auto rounded-md border border-[var(--bark-800)] bg-[var(--bark-900)]/40">
        {shown.map((task) => {
          const open = opened === task.id
          return (
            <li key={task.id}>
              <div className="flex items-center gap-2 px-3 py-1.5">
                <button type="button" onClick={() => setOpened(open ? null : task.id)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] ${STATUS_STYLE[task.status]}`}>{task.status}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{task.title}</span>
                  {task.waitingOn.length > 0 && (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-slate-500"><Clock size={10} /> waiting on {task.waitingOn.map((dep) => dep.title).join(', ')}</span>
                  )}
                  {task.status === 'accepted' && !task.ready && <CircleSlash size={12} className="shrink-0 text-slate-500" />}
                  {task.agent && <span className="shrink-0 font-mono text-[10px] text-slate-400">{task.agent}</span>}
                </button>
                {task.status === 'proposed' && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => accept.mutate(task.id)}
                      disabled={accept.isPending}
                      className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/20 px-2 py-0.5 text-[11px] text-emerald-300 disabled:opacity-40"
                    >
                      <Check size={10} /> Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => drop.mutate(task.id)}
                      disabled={drop.isPending}
                      className="flex items-center gap-1 rounded border border-slate-500/20 bg-slate-500/10 px-2 py-0.5 text-[11px] text-slate-400 disabled:opacity-40"
                    >
                      <X size={10} /> Drop
                    </button>
                  </div>
                )}
              </div>
              {open && (
                <div className="space-y-1 px-3 pb-2 pl-6">
                  {task.intent && <p className="text-xs text-slate-400">{task.intent}</p>}
                  <p className="text-xs text-slate-500"><span className="text-slate-600">done means:</span> {task.doneMeans}</p>
                  {task.checks?.command && <p className="font-mono text-[11px] text-slate-500">checked by: {task.checks.command}</p>}
                  {task.evidence && <p className="whitespace-pre-wrap text-[11px] text-slate-400">{task.evidence}</p>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
