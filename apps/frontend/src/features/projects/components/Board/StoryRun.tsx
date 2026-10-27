import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Brain, Loader2, Wrench } from 'lucide-react'
import type { EngineEvent } from '../../../engine'
import type { RunInstance } from '../../../engine'
import { nodeAtDepth, statesFromEvents, statesFromKey, statesKey } from '../../../engine'
import { groupPathIn } from '../../../engine'
import { roundsFrom, shownArgs, type Round } from '../../../engine'
import { ProcedureCanvas } from '../../../engine'
import { useQuery } from '@tanstack/react-query'
import { canvasContextFor } from '../../../engine'
import { procedureKeys } from '../../../engine'
import { engineKeys } from '../../../engine'
import { RunControls, StopRun } from '../../../engine'
import { keyedBy, useWorkSource } from '../../lib/work-source'

const OUTCOME_TONE: Record<string, string> = { ok: 'text-emerald-300 bg-emerald-500/10' }

export function StoryRun({ run, turnId, events }: { run: RunInstance; turnId: string; events: readonly EngineEvent[] }) {
  const runs = useWorkSource().can('run-work')
  return (
    <section className="space-y-2" data-testid="story-run">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-mono rounded bg-[var(--bark-800)] px-2 py-0.5 text-slate-300">{run.agentId ?? 'run'} · {run.loopId ?? 'procedure'}</span>
        {run.currentNode && !run.finished && (
          <span className="flex items-center gap-1 font-mono text-[var(--leaf)]" data-testid="story-run-now">
            <Loader2 size={10} className="animate-spin" aria-hidden="true" /> {run.currentNode}
          </span>
        )}
        {run.finished && (
          <span className={`rounded px-2 py-0.5 font-mono ${OUTCOME_TONE[run.outcome ?? ''] ?? 'text-amber-300 bg-amber-500/10'}`}>
            {run.outcome}{run.outcomeReason ? ` — ${run.outcomeReason}` : ''}
          </span>
        )}
        {runs && <StopRun run={run} />}
      </div>
      {runs && <RunControls run={run} inTree />}
      {run.loopId && <RunProcedure procedureId={run.loopId} turnId={turnId} current={run.finished ? undefined : run.currentNode} events={events} />}
      <Rounds events={events} live={!run.finished} />
    </section>
  )
}

function RunProcedure({ procedureId, turnId, current, events }: { procedureId: string; turnId: string; current: string | undefined; events: readonly EngineEvent[] }) {
  const source = useWorkSource()
  const stored = useQuery({ queryKey: keyedBy(source, procedureKeys.one(procedureId)), queryFn: () => source.getProcedure(procedureId, turnId), retry: false })
  const context = useQuery({ queryKey: keyedBy(source, engineKeys.extensions()), queryFn: async () => canvasContextFor(await source.listExtensions()), staleTime: Infinity })
  const [chosen, setChosen] = useState<string[]>([])
  const [follow, setFollow] = useState(true)
  const procedure = stored.data?.procedure

  const followed = useMemo(() => {
    if (!current || !procedure || !context.data) return []
    const at = groupPathIn(procedure, current, context.data)
    return at && nodeAtDepth(current, at) ? at : []
  }, [current, procedure, context.data])
  const path = follow ? followed : chosen
  const key = statesKey(statesFromEvents(events, path))
  const states = useMemo(() => statesFromKey(key), [key])

  const open = (next: string[]) => {
    setFollow(false)
    setChosen(next)
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span>Procedure <span className="font-mono text-slate-300">{procedureId}</span></span>
        {path.length > 0 && <span className="font-mono text-slate-500">› {path.join(' › ')}</span>}
        {path.length > 0 && (
          <button type="button" onClick={() => open(path.slice(0, -1))} className="text-sky-300 hover:underline cursor-pointer">
            ← out of {path[path.length - 1]}
          </button>
        )}
        <label className="ml-auto flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={follow} onChange={(event) => { setChosen(path); setFollow(event.target.checked) }} />
          Follow the step it is on
        </label>
      </div>
      <div className="h-[26rem] overflow-hidden rounded border border-[var(--bark-700)]" data-testid="story-run-procedure">
        {(stored.isPending || context.isPending) && (
          <p className="flex h-full items-center justify-center gap-2 text-xs text-slate-500">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Opening {procedureId}…
          </p>
        )}
        {stored.isError && (
          <p className="flex h-full items-center justify-center text-xs text-rose-400">The procedure "{procedureId}" is not here any more, so it cannot be drawn.</p>
        )}
        {context.isError && (
          <p className="flex h-full items-center justify-center text-xs text-rose-400">The platform's operations could not be loaded, so the procedure cannot be drawn.</p>
        )}
        {procedure && context.data && (
          <ReactFlowProvider>
            <ProcedureCanvas
              procedure={procedure}
              path={path}
              problems={[]}
              states={states}
              selection={[]}
              editable={false}
              onChange={() => undefined}
              onSelect={() => undefined}
              onOpenGroup={(groupId) => open([...path, groupId])}
              onRefused={() => undefined}
              focus={follow && current ? nodeAtDepth(current, path) : undefined}
            />
          </ReactFlowProvider>
        )}
      </div>
    </div>
  )
}

function Rounds({ events, live }: { events: readonly EngineEvent[]; live: boolean }) {
  const rounds = useMemo(() => roundsFrom(events), [events])
  const list = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const element = list.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [rounds])

  if (rounds.length === 0) return <p className="text-[12px] text-slate-500">It has not asked its model anything yet.</p>
  return (
    <ol
      ref={list}
      onScroll={(event) => {
        const element = event.currentTarget
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
      }}
      className="max-h-[36rem] space-y-2 overflow-y-auto overflow-x-hidden pr-1 [&_*]:[overflow-wrap:anywhere]"
      aria-label="Model rounds"
      data-testid="story-run-rounds"
    >
      {rounds.map((round, index) => <RoundCard key={`${round.by}-${round.index}-${round.nodeId}-${index}`} round={round} working={live && index === rounds.length - 1 && round.by === 'model'} />)}
    </ol>
  )
}

const RoundCard = memo(function RoundCard({ round, working }: { round: Round; working: boolean }) {
  return (
    <li className="space-y-1.5 rounded-md border border-[var(--bark-800)] bg-[var(--bark-900)]/40 p-2 text-xs [content-visibility:auto] [contain-intrinsic-size:auto_12rem]" data-testid="story-run-round">
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
        <span className="font-semibold text-slate-300">{round.by === 'model' ? `Round ${round.index}` : 'The procedure itself'}</span>
        <span className="font-mono">{round.nodeId}</span>
        {round.model && <span>{round.model}</span>}
        {round.startedAt && <span>{new Date(round.startedAt).toLocaleTimeString()}</span>}
        {working && <span className="flex items-center gap-1 text-[var(--leaf)]"><Loader2 size={9} className="animate-spin" aria-hidden="true" /> working</span>}
      </div>
      {round.thinking && (
        <details open className="rounded border border-[var(--bark-800)]">
          <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1 text-[11px] text-slate-400">
            <Brain size={11} aria-hidden="true" /> Thinking
          </summary>
          <pre className="whitespace-pre-wrap px-2 pb-2 font-mono text-[11px] text-slate-400">{round.thinking}</pre>
        </details>
      )}
      {round.content && <p className="whitespace-pre-wrap leading-relaxed text-slate-200">{round.content}</p>}
      {round.calls.map((call) => (
        <div key={call.callId} className="flex items-start gap-2 text-slate-300" data-testid="story-run-call">
          <Wrench size={11} className="mt-0.5 shrink-0 text-slate-500" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            <div>
              <span className="font-mono font-medium">{call.name}</span>
              {call.running
                ? <span className="text-slate-500"> · running…</span>
                : <span className={call.ok ? 'text-emerald-400' : 'text-rose-400'}>{call.ok ? ' · ok' : ' · failed'}</span>}
            </div>
            <pre className="whitespace-pre-wrap rounded bg-[var(--bark-950)] p-1.5 font-mono text-[11px] text-slate-300">{shownArgs(call.args)}</pre>
            {call.digest && (
              <details>
                <summary className="cursor-pointer text-[10px] text-slate-500 hover:text-slate-300">What it gave back</summary>
                <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--bark-950)] p-1.5 font-mono text-[11px] text-slate-400">{call.digest}</pre>
              </details>
            )}
          </div>
        </div>
      ))}
    </li>
  )
}, (before, after) => before.working === after.working && sameRound(before.round, after.round))

function sameRound(a: Round, b: Round): boolean {
  return a.index === b.index && a.by === b.by && a.nodeId === b.nodeId && a.thinking.length === b.thinking.length && a.content.length === b.content.length
    && a.calls.length === b.calls.length && a.calls.every((call, at) => {
      const other = b.calls[at]
      return other !== undefined && call.callId === other.callId && call.running === other.running && call.ok === other.ok && call.digest === other.digest
    })
}

export default StoryRun
