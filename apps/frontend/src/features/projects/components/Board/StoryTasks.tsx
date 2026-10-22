import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { engineKeys, type EngineTask, type TaskStatus } from '../../../engine'
import { errorMessage } from '../../../../api/client'
import { keyedBy, useWorkSource } from '../../lib/work-source'
import { waitingOn } from './hub-waiting'

const STATUS_WORD: Record<TaskStatus, string> = {
  proposed: 'proposed',
  accepted: 'to do',
  running: 'running',
  waiting: 'waiting',
  done: 'done',
  failed: 'failed',
  dropped: 'dropped',
}

const STATUS_TONE: Record<TaskStatus, string> = {
  proposed: 'text-sky-300',
  accepted: 'text-slate-400',
  running: 'text-blue-300',
  waiting: 'text-amber-300',
  done: 'text-emerald-300',
  failed: 'text-red-300',
  dropped: 'text-slate-600',
}

export function StoryTasks({ tasks }: { tasks: readonly EngineTask[] }) {
  const qc = useQueryClient()
  const source = useWorkSource()
  const decides = source.can('change-work')
  const settled = () => { void qc.invalidateQueries({ queryKey: keyedBy(source, engineKeys.tasks()) }) }
  const accept = useMutation({ mutationFn: source.acceptTask, onSettled: settled })
  const drop = useMutation({ mutationFn: source.dropTask, onSettled: settled })
  const failed = accept.error ?? drop.error
  const busy = accept.isPending || drop.isPending

  const proposed = tasks.filter((task) => task.status === 'proposed')
  const planned = tasks.filter((task) => task.status !== 'proposed' && task.status !== 'dropped')
  const dropped = tasks.filter((task) => task.status === 'dropped')
  if (tasks.length === 0) return null

  return (
    <section aria-label="Tasks" className="space-y-2" data-testid="story-tasks">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Tasks</h3>

      {proposed.length > 0 && (
        <div className="rounded-md border border-sky-800/60 bg-sky-950/20 p-2 space-y-1.5">
          <p className="text-[11px] text-sky-200">Proposed while it was worked — nothing is done about them until {decides ? 'you accept them' : 'an owner or collaborator accepts them'}.</p>
          <ul className="space-y-1.5">
            {proposed.map((task) => (
              <li key={task.id} className="flex items-start gap-2">
                <div className="flex-1 min-w-0 text-[12px]">
                  <div className="text-slate-200 break-words">{task.title}</div>
                  <div className="text-slate-500 break-words">Done means: {task.doneMeans}</div>
                </div>
                {waitingOn(source.hub, ['accept-task', 'drop-task'], 'taskId', task.id) ? (
                  <span className="shrink-0 text-[11px] text-amber-200" data-testid="task-waiting">{waitingOn(source.hub, ['accept-task', 'drop-task'], 'taskId', task.id)}</span>
                ) : decides && (
                  <>
                    <button type="button" disabled={busy} onClick={() => accept.mutate(task.id)} aria-label={`Accept “${task.title}”`} className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-[11px] text-white cursor-pointer disabled:opacity-50">
                      <Check size={11} aria-hidden="true" /> Accept
                    </button>
                    <button type="button" disabled={busy} onClick={() => drop.mutate(task.id)} aria-label={`Drop “${task.title}”`} className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--bark-700)] hover:bg-[var(--bark-600)] text-[11px] text-slate-200 cursor-pointer disabled:opacity-50">
                      <X size={11} aria-hidden="true" /> Drop
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {failed && <p className="text-[11px] text-red-400">{errorMessage(failed) || 'That did not go through.'}</p>}
        </div>
      )}

      {planned.length > 0 && (
        <ol className="space-y-1">
          {planned.map((task) => (
            <li key={task.id} className="text-[12px] flex items-start gap-2">
              <span className={`shrink-0 w-14 text-[10px] uppercase tracking-wide mt-0.5 ${STATUS_TONE[task.status]}`}>{STATUS_WORD[task.status]}</span>
              <span className="min-w-0">
                <span className="text-slate-200 break-words">{task.title}</span>
                <span className="block text-slate-500 break-words">Done means: {task.doneMeans}</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      {dropped.length > 0 && (
        <p className="text-[11px] text-slate-600">{dropped.length} dropped: {dropped.map((task) => task.title).join(', ')}</p>
      )}
    </section>
  )
}

export default StoryTasks
