import { useMemo, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { CircleAlert, Loader2 } from 'lucide-react'
import type { NodeTrace } from '@koala/agent-engine/procedure'
import ProcedureCanvas from '../Studio/ProcedureCanvas'
import { useProcedure, useRunTraces } from '../Studio/shared'
import { nodeAtDepth, statesFromTraces } from '../../lib/procedure-run'
import { groupPathIn } from '../../lib/procedure-drafts'
import type { ScenarioResult } from '../../api/evals'

function Json({ value }: { value: unknown }) {
  if (value === undefined) return <span className="text-slate-600">nothing</span>
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export default function ScenarioTrace({ result }: { result: ScenarioResult }) {
  const loaded = useProcedure(result.procedure.id)
  const traces = useRunTraces(result.runId, true)
  const [focusedAt, setFocusedAt] = useState<number>()
  const [path, setPath] = useState<string[]>([])

  const steps = useMemo(() => traces.data ?? [], [traces.data])
  const focused = steps.find((trace) => trace.sequence === focusedAt)
  const states = useMemo(
    () => statesFromTraces(steps, path, focusedAt),
    [steps, path, focusedAt],
  )

  const focus = (trace: NodeTrace | undefined) => {
    if (!trace || !loaded.data) return setFocusedAt(undefined)
    const at = groupPathIn(loaded.data.procedure, trace.node)
    if (at && nodeAtDepth(trace.node, at)) setPath(at)
    setFocusedAt(trace.sequence)
  }

  return (
    <div className="flex min-h-[26rem] min-w-0 flex-col gap-2 lg:flex-row">
      <div className="h-[26rem] min-w-0 flex-1 overflow-hidden rounded border border-slate-800">
        {loaded.isPending && (
          <p className="flex h-full items-center justify-center gap-2 text-xs text-slate-500">
            <Loader2 size={14} className="animate-spin" /> Opening {result.procedure.id}…
          </p>
        )}
        {loaded.isError && (
          <p className="flex h-full items-center justify-center text-xs text-rose-400">
            The procedure "{result.procedure.id}" is not here any more, so its canvas cannot be shown.
          </p>
        )}
        {loaded.data && (
          <ReactFlowProvider>
            <ProcedureCanvas
              procedure={loaded.data.procedure}
              path={path}
              problems={[]}
              states={states}
              selection={focused ? [nodeAtDepth(focused.node, path) ?? focused.node] : []}
              editable={false}
              onChange={() => undefined}
              onSelect={() => undefined}
              onOpenGroup={(groupId) => setPath((current) => [...current, groupId])}
              onRefused={() => undefined}
            />
          </ReactFlowProvider>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 gap-2 lg:w-[34rem] lg:shrink-0">
        <ol className="w-52 shrink-0 overflow-y-auto rounded border border-slate-800 p-1 text-[11px]" aria-label="Trace">
          {path.length > 0 && (
            <li>
              <button type="button" onClick={() => setPath([])} className="w-full px-1.5 py-0.5 text-left text-sky-300 hover:underline">
                ← out of {path[path.length - 1]}
              </button>
            </li>
          )}
          {traces.isPending && <li className="p-2 text-slate-500">Loading the trace…</li>}
          {!traces.isPending && steps.length === 0 && (
            <li className="p-2 text-slate-500">Nothing was recorded for this scenario.</li>
          )}
          {steps.map((trace) => (
            <li key={trace.sequence}>
              <button
                type="button"
                onClick={() => focus(focusedAt === trace.sequence ? undefined : trace)}
                className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left ${focusedAt === trace.sequence ? 'bg-sky-500/20' : 'hover:bg-slate-800'} ${trace.role === 'value' ? 'text-slate-500' : 'text-slate-200'}`}
              >
                <span className="w-6 shrink-0 text-right font-mono text-[10px] text-slate-600">{trace.sequence}</span>
                {trace.error && <CircleAlert size={11} className="shrink-0 text-rose-400" />}
                <span className="truncate font-mono">{trace.node}</span>
                {trace.exit && <span className="truncate text-sky-300">→ {trace.exit}</span>}
              </button>
            </li>
          ))}
        </ol>

        <div className="min-w-0 flex-1 overflow-y-auto rounded border border-slate-800 p-2 text-[11px]">
          {!focused && <p className="text-slate-500">Pick a step to see what went in and came out, and where it sits on the canvas.</p>}
          {focused && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-slate-100">{focused.node}</span>
                <span className="text-slate-500">{focused.kind} · {focused.role} · step {focused.step}{focused.cleanup ? ' · cleanup' : ''}</span>
              </div>
              {focused.error && <p className="text-rose-300">Failed: {focused.error}</p>}
              {focused.interrupted && <p className="text-amber-300">Interrupted: {focused.interrupted}</p>}
              {focused.finish && (
                <p className="text-slate-300">
                  Finished the run: {focused.finish.outcome}{focused.finish.reason ? ` — ${focused.finish.reason}` : ''}
                </p>
              )}
              <div>
                <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Went in</h4>
                <Json value={focused.inputs} />
              </div>
              <div>
                <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Came out</h4>
                <Json value={focused.outputs} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
