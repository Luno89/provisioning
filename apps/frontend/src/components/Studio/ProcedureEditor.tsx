import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import {
  ArrowLeft,
  Braces,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Copy,
  Loader2,
  Network,
  Redo2,
  Save,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react'
import { procedureErrors, type NodeTrace, type Procedure, type ProcedureProblem } from '@koala/agent-engine/procedure'
import { ENGINE_EVENT_CHANNEL, type EngineEvent } from '../../api/engine'
import { useSocketEvent } from '../../stores/socket'
import { addNode, bodyAt, definitionOf, isEditable, isRefused, libraryOf } from '../../lib/procedure-canvas'
import { freeSpot, layoutProcedure, nodeHeight } from '../../lib/procedure-layout'
import { record, redo, startHistory, undo, type DraftHistory } from '../../lib/draft-history'
import { reduceEngineEvents } from '../../lib/engine-run-state'
import { nodeAtDepth, statesFromEvents, statesFromTraces, tracesFromEvents } from '../../lib/procedure-run'
import { copyOf, groupPathIn, localProblems, mergeProblems, procedureIdFrom } from '../../lib/procedure-drafts'
import ProcedureCanvas from './ProcedureCanvas'
import Palette from './Palette'
import Inspector from './Inspector'
import ProblemsPanel from './ProblemsPanel'
import RunPanel, { type StudioRun } from './RunPanel'
import {
  STUDIO_CONTEXT,
  errorMessage,
  useDeleteProcedure,
  useProcedure,
  useProcedureList,
  useRunTraces,
  useSaveProcedure,
  useServerProblems,
} from './shared'

const JsonView = lazy(() => import('./JsonView'))
const CodeView = lazy(() => import('./CodeView'))

const button = 'flex items-center gap-1.5 rounded-md border border-[var(--bark-600)] px-2.5 py-1 text-xs text-slate-300 hover:bg-[var(--bark-700)] disabled:cursor-not-allowed disabled:opacity-40'

const pretty = (procedure: Procedure) => JSON.stringify(procedure)

const typingInto = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export default function ProcedureEditor({ procedureId }: { procedureId: string }) {
  const loaded = useProcedure(procedureId)

  if (loaded.isPending) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-400"><Loader2 size={16} className="mr-2 animate-spin" /> Opening {procedureId}…</div>
  }
  if (loaded.isError || !loaded.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-slate-400">
        <p>{loaded.isError ? errorMessage(loaded.error) : `There is no procedure called "${procedureId}".`}</p>
        <Link to="/studio" className="text-[var(--leaf-light)] hover:underline">Back to all procedures</Link>
      </div>
    )
  }

  return (
    <ReactFlowProvider>
      <EditorBody key={procedureId} saved={loaded.data.procedure} mine={loaded.data.mine} />
    </ReactFlowProvider>
  )
}

function EditorBody({ saved, mine }: { saved: Procedure; mine: boolean }) {
  const navigate = useNavigate()
  const flow = useReactFlow()
  const list = useProcedureList()
  const save = useSaveProcedure()
  const remove = useDeleteProcedure()

  const [history, setHistory] = useState<DraftHistory<Procedure>>(() => startHistory(saved))
  const draft = history.present
  const [openPath, setPath] = useState<string[]>([])
  const [selection, setSelection] = useState<string[]>([])
  const [view, setView] = useState<'canvas' | 'code' | 'json'>('canvas')
  const [panel, setPanel] = useState<'problems' | 'run' | null>(null)
  const [showPalette, setShowPalette] = useState(true)
  const [showInspector, setShowInspector] = useState(true)
  const [notice, setNotice] = useState<{ tone: 'refused' | 'saved' | 'failed'; text: string } | null>(null)
  const [saveProblems, setSaveProblems] = useState<ProcedureProblem[] | undefined>()
  const [confirming, setConfirming] = useState<'leave' | 'delete' | null>(null)
  const [copyName, setCopyName] = useState<string | null>(null)
  const [tidying, setTidying] = useState(false)
  const [runs, setRuns] = useState<StudioRun[]>([])
  const [activeRunId, setActiveRunId] = useState<string>()
  const [replayAt, setReplayAt] = useState<number>()
  const unclaimed = useRef<EngineEvent[]>([])
  const canvasArea = useRef<HTMLDivElement>(null)
  const added = useRef(0)

  const path = useMemo(
    () => (openPath.length === 0 || libraryOf(draft, STUDIO_CONTEXT).has(openPath[openPath.length - 1]!) ? openPath : []),
    [draft, openPath],
  )
  const dirty = pretty(draft) !== pretty(saved)
  const editable = isEditable(draft, path)
  const local = useMemo(() => localProblems(draft), [draft])
  const server = useServerProblems(draft)
  const problems = useMemo(() => mergeProblems(local, saveProblems ?? server.problems), [local, saveProblems, server.problems])
  const errors = procedureErrors(problems)

  const change = useCallback((next: Procedure, mergeKey?: string) => {
    setHistory((current) => record(current, next, mergeKey))
    setSaveProblems(undefined)
  }, [])

  const refuse = useCallback((text: string) => setNotice({ tone: 'refused', text }), [])

  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(null), notice.tone === 'refused' ? 6000 : 3500)
    return () => clearTimeout(timer)
  }, [notice])

  useSocketEvent<EngineEvent>(ENGINE_EVENT_CHANNEL, (event) => {
    setRuns((current) => {
      if (!current.some((run) => run.runId === event.runId)) {
        unclaimed.current = [...unclaimed.current.slice(-500), event]
        return current
      }
      return current.map((run) => (run.runId === event.runId ? { ...run, events: [...run.events, event] } : run))
    })
  })

  const activeRun = runs.find((run) => run.runId === activeRunId)
  const finished = activeRun ? reduceEngineEvents(activeRun.runId, activeRun.events).finished : false
  const stored = useRunTraces(activeRunId, finished)
  const traces = useMemo(
    () => (stored.data && stored.data.length > 0 ? stored.data : activeRun ? tracesFromEvents(activeRun.events) : []),
    [stored.data, activeRun],
  )

  const states = useMemo(() => {
    if (replayAt !== undefined) return statesFromTraces(traces, path, replayAt)
    return activeRun ? statesFromEvents(activeRun.events, path) : {}
  }, [replayAt, traces, activeRun, path])

  const doSave = useCallback(async () => {
    if (save.isPending) return
    try {
      const outcome = await save.mutateAsync(draft)
      if (!outcome.saved) {
        setSaveProblems(outcome.problems)
        setPanel('problems')
        setNotice({ tone: 'failed', text: `Not saved — ${procedureErrors(outcome.problems).length} problems have to be fixed first` })
        return
      }
      setHistory((current) => ({ ...current, present: outcome.procedure }))
      setNotice({ tone: 'saved', text: `Saved as version ${outcome.procedure.version}` })
    } catch (err) {
      setNotice({ tone: 'failed', text: `Not saved — ${errorMessage(err)}` })
    }
  }, [draft, save])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey
      if (!command) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        void doSave()
        return
      }
      if (typingInto(event.target)) return
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        setHistory(undo)
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault()
        setHistory(redo)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doSave])

  useEffect(() => {
    if (!dirty) return undefined
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const addFromPalette = (kind: string, group?: string) => {
    const bounds = canvasArea.current?.getBoundingClientRect()
    const centre = bounds
      ? flow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : { x: 0, y: 0 }
    const offset = (added.current % 6) * 24
    added.current += 1
    const body = bodyAt(draft, path, STUDIO_CONTEXT)
    const spot = freeSpot(body?.nodes.map((node) => ({ ...node.position, height: nodeHeight(definitionOf(node, draft, STUDIO_CONTEXT)) })) ?? [], { x: centre.x - 120 + offset, y: centre.y - 40 + offset })
    const result = addNode(draft, path, kind, spot, STUDIO_CONTEXT, group)
    if (isRefused(result)) return refuse(result.refused)
    change(result.procedure)
    setSelection([result.id])
  }

  const tidy = async () => {
    setTidying(true)
    try {
      change(await layoutProcedure(draft, path, STUDIO_CONTEXT))
      setTimeout(() => void flow.fitView({ padding: 0.2, duration: 300 }), 50)
    } finally {
      setTidying(false)
    }
  }

  const openGroup = (groupId: string) => {
    setPath((current) => [...current, groupId])
    setSelection([])
  }

  const showProblem = (problem: ProcedureProblem) => {
    setView('canvas')
    setPath(problem.group ? [problem.group] : [])
    setSelection(problem.node ? [problem.node] : [])
  }

  const replay = (trace: NodeTrace | undefined) => {
    if (!trace) return setReplayAt(undefined)
    const at = groupPathIn(draft, trace.node)
    setView('canvas')
    setPath(at)
    const shown = nodeAtDepth(trace.node, at)
    setSelection(shown ? [shown] : [])
    setReplayAt(trace.sequence)
  }

  const started = (runId: string) => {
    const early = unclaimed.current.filter((event) => event.runId === runId)
    unclaimed.current = unclaimed.current.filter((event) => event.runId !== runId)
    setRuns((current) => [...current, { runId, events: early }])
    setActiveRunId(runId)
    setReplayAt(undefined)
  }

  const takenIds = new Set(list.data?.procedures.map((procedure) => procedure.id) ?? [])
  const copyId = copyName ? procedureIdFrom(copyName) : ''
  const copyRefusal = copyName === null ? undefined
    : !copyId ? 'give the copy a name'
      : takenIds.has(copyId) ? `"${copyId}" is already taken`
        : undefined

  const saveCopy = async () => {
    if (copyName === null || copyRefusal) return
    try {
      const outcome = await save.mutateAsync(copyOf(draft, copyId, copyName.trim()))
      if (!outcome.saved) {
        setNotice({ tone: 'failed', text: `The copy was not saved — ${outcome.problems[0]?.message ?? 'it has problems'}` })
        return
      }
      setCopyName(null)
      void navigate({ to: '/studio/$procedureId', params: { procedureId: outcome.procedure.id } })
    } catch (err) {
      setNotice({ tone: 'failed', text: `The copy was not saved — ${errorMessage(err)}` })
    }
  }

  const trail = [
    { title: draft.name || draft.id, path: [] as string[] },
    ...path.map((groupId, index) => ({
      title: libraryOf(draft, STUDIO_CONTEXT).get(groupId)?.title ?? groupId,
      path: path.slice(0, index + 1),
    })),
  ]

  const blockedBecause = dirty ? 'Save your changes first — a run uses the saved version.' : undefined

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bark-900)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--bark-700)] px-3 py-2">
        {confirming === 'leave' ? (
          <span className="flex items-center gap-2 text-xs text-amber-200">
            Leave without saving?
            <button type="button" className={button} onClick={() => void navigate({ to: '/studio' })}>Discard changes</button>
            <button type="button" className={button} onClick={() => setConfirming(null)}>Stay</button>
          </span>
        ) : (
          <button type="button" className={button} onClick={() => (dirty ? setConfirming('leave') : void navigate({ to: '/studio' }))}>
            <ArrowLeft size={13} /> Procedures
          </button>
        )}

        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-slate-100">{draft.name || draft.id}</h1>
          <p className="truncate font-mono text-[10px] text-slate-500">
            {draft.id} · v{saved.version} · {mine ? 'yours' : 'built-in'}{dirty ? ' · unsaved changes' : ''}
          </p>
        </div>

        {!mine && (
          <span className="rounded-md bg-sky-500/10 px-2 py-1 text-[11px] text-sky-200" title="Your copy keeps the same id, so every agent that uses this procedure uses your copy instead">
            Built-in: saving makes it your own copy
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="button" className={button} disabled={history.past.length === 0} onClick={() => setHistory(undo)} title="Undo (Ctrl+Z)"><Undo2 size={13} /></button>
          <button type="button" className={button} disabled={history.future.length === 0} onClick={() => setHistory(redo)} title="Redo (Ctrl+Shift+Z)"><Redo2 size={13} /></button>
          <button type="button" className={button} disabled={!editable || tidying || view !== 'canvas'} onClick={() => void tidy()} title="Lay the nodes out left to right in the order they run">
            {tidying ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} Tidy
          </button>
          <div className="flex overflow-hidden rounded-md border border-[var(--bark-600)]">
            <button type="button" onClick={() => setView('canvas')} className={`flex items-center gap-1 px-2.5 py-1 text-xs ${view === 'canvas' ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400'}`}><Network size={13} /> Canvas</button>
            <button type="button" onClick={() => setView('code')} className={`flex items-center gap-1 px-2.5 py-1 text-xs ${view === 'code' ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400'}`}><Code2 size={13} /> Code</button>
            <button type="button" onClick={() => setView('json')} className={`flex items-center gap-1 px-2.5 py-1 text-xs ${view === 'json' ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400'}`}><Braces size={13} /> JSON</button>
          </div>

          {copyName === null ? (
            <button type="button" className={button} onClick={() => setCopyName(`${draft.name} copy`)}><Copy size={13} /> Save as copy</button>
          ) : (
            <span className="flex items-center gap-1">
              <input aria-label="Name of the copy" autoFocus value={copyName} onChange={(event) => setCopyName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveCopy() }} className="w-40 rounded-md border border-[var(--bark-600)] bg-[var(--bark-800)] px-2 py-1 text-xs text-slate-200 outline-none" />
              <button type="button" className={button} disabled={Boolean(copyRefusal) || save.isPending} onClick={() => void saveCopy()} title={copyRefusal ?? `Saves as "${copyId}"`}>Save copy</button>
              <button type="button" className={button} onClick={() => setCopyName(null)} aria-label="Cancel copy"><X size={13} /></button>
              <span className="text-[10px] text-slate-500">{copyRefusal ?? copyId}</span>
            </span>
          )}

          {mine && (confirming === 'delete' ? (
            <span className="flex items-center gap-1 text-xs text-red-200">
              Delete your copy?
              <button type="button" className={`${button} !text-red-300`} onClick={() => { void remove.mutateAsync(draft.id).then(() => navigate({ to: '/studio' })) }}>Delete</button>
              <button type="button" className={button} onClick={() => setConfirming(null)}>Keep</button>
            </span>
          ) : (
            <button type="button" className={button} onClick={() => setConfirming('delete')} title="Delete your copy. If it replaced a built-in, the built-in comes back."><Trash2 size={13} /></button>
          ))}

          <button
            type="button"
            onClick={() => void doSave()}
            disabled={save.isPending || (!dirty && mine) || errors.length > 0}
            title={errors.length > 0 ? 'Fix the errors in Problems first' : 'Save (Ctrl+S)'}
            className="flex items-center gap-1.5 rounded-md border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/25 px-3 py-1 text-xs font-semibold text-[var(--leaf-light)] hover:bg-[var(--leaf-stem)]/35 disabled:opacity-40"
          >
            {save.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {view === 'canvas' && showPalette && <Palette procedure={draft} path={path} editable={editable} onAdd={addFromPalette} />}

        <div className="relative flex min-w-0 flex-1 flex-col">
          {view === 'canvas' && (
            <nav className="flex items-center gap-1 border-b border-[var(--bark-700)] px-2 py-1.5 text-xs" aria-label="Where you are">
              <button type="button" onClick={() => setShowPalette(!showPalette)} aria-label={showPalette ? 'Hide the node list' : 'Show the node list'} title={showPalette ? 'Hide the node list' : 'Show the node list'} className="mr-1 text-slate-500 hover:text-slate-200">
                {showPalette ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
              </button>
              {trail.map((crumb, index) => (
                <span key={crumb.path.join('/')} className="flex items-center gap-1">
                  {index > 0 && <ChevronRight size={12} className="text-slate-600" />}
                  <button type="button" onClick={() => { setPath(crumb.path); setSelection([]) }} className={index === trail.length - 1 ? 'text-slate-100' : 'text-slate-400 hover:text-slate-200'}>
                    {crumb.title}
                  </button>
                </span>
              ))}
              {!editable && <span className="ml-2 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-200">built-in group · view only</span>}
              {replayAt !== undefined && (
                <button type="button" onClick={() => setReplayAt(undefined)} className="ml-auto flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-200">
                  replaying step {replayAt} <X size={10} />
                </button>
              )}
              <button type="button" onClick={() => setShowInspector(!showInspector)} aria-label={showInspector ? 'Hide the inspector' : 'Show the inspector'} title={showInspector ? 'Hide the inspector' : 'Show the inspector'} className={`${replayAt === undefined ? 'ml-auto' : 'ml-2'} text-slate-500 hover:text-slate-200`}>
                {showInspector ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
              </button>
            </nav>
          )}

          <div ref={canvasArea} className="relative min-h-0 flex-1">
            {view === 'canvas' ? (
              <ProcedureCanvas
                procedure={draft}
                path={path}
                problems={problems}
                states={states}
                selection={selection}
                editable={editable}
                onChange={change}
                onSelect={setSelection}
                onOpenGroup={openGroup}
                onRefused={refuse}
              />
            ) : (
              <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-slate-500"><Loader2 size={14} className="mr-2 animate-spin" /> Opening the editor…</div>}>
                {view === 'code' ? <CodeView procedure={draft} onChange={change} /> : <JsonView procedure={draft} onChange={change} />}
              </Suspense>
            )}

            {notice && (
              <div
                role={notice.tone === 'saved' ? 'status' : 'alert'}
                className={`absolute left-1/2 top-3 z-10 flex max-w-lg -translate-x-1/2 items-center gap-2 rounded-md border px-3 py-2 text-xs shadow-xl ${
                  notice.tone === 'saved' ? 'border-emerald-500/40 bg-emerald-950 text-emerald-200' : 'border-red-500/40 bg-red-950 text-red-200'
                }`}
              >
                {notice.text}
                <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={12} /></button>
              </div>
            )}
          </div>
        </div>

        {view === 'canvas' && showInspector && (
          <Inspector
            procedure={draft}
            path={path}
            selection={selection}
            editable={editable}
            problems={problems}
            onChange={change}
            onSelect={setSelection}
            onOpenGroup={openGroup}
            onRefused={refuse}
          />
        )}
      </div>

      <div className={`flex flex-col border-t border-[var(--bark-700)] ${panel ? 'h-72' : ''}`}>
        <div className="flex items-center gap-1 px-2 py-1">
          {(['problems', 'run'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setPanel(panel === tab ? null : tab)}
              className={`rounded px-2 py-0.5 text-xs ${panel === tab ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400 hover:text-slate-200'} ${tab === 'problems' && errors.length > 0 ? '!text-red-300' : ''}`}
            >
              {tab === 'problems' ? `Problems${problems.length ? ` (${problems.length})` : ''}` : `Run${runs.length ? ` (${runs.length})` : ''}`}
            </button>
          ))}
          <button type="button" aria-label={panel ? 'Hide panel' : 'Show panel'} onClick={() => setPanel(panel ? null : 'problems')} className="ml-auto text-slate-500 hover:text-slate-300">
            {panel ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
        {panel === 'problems' && (
          <div className="min-h-0 flex-1">
            <ProblemsPanel problems={problems} checking={server.checking} onShow={showProblem} />
          </div>
        )}
        {panel === 'run' && (
          <div className="min-h-0 flex-1">
            <RunPanel
              procedure={draft}
              blockedBecause={blockedBecause}
              runs={runs}
              activeRunId={activeRunId}
              traces={traces}
              replayAt={replayAt}
              onStarted={started}
              onPickRun={(runId) => { setActiveRunId(runId); setReplayAt(undefined) }}
              onReplay={replay}
            />
          </div>
        )}
      </div>
    </div>
  )
}
