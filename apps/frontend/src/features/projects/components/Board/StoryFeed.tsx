import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Radio } from 'lucide-react'
import { groveKeys } from '../../api/grove'
import { TURN_LOG_CHANNEL } from '../../../engine'
import { keyedBy, useWorkSource } from '../../lib/work-source'
import { errorMessage } from '../../../../api/client'
import { useSocketEvent } from '../../../platform'
import { createTurnFollower } from '../../../engine'
import { applyInstanceEvents, instancesUnder, type RunInstance } from '../../../engine'
import type { TurnLogEntry } from '../../../engine'
import type { Leaf } from '../../lib/leaf-types'
import StoryRun from './StoryRun'
import Reading from '../Reading'
import { keptForStory, withInstanceEvents } from '../../../engine'
import type { EngineEvent } from '../../../engine'

export function StoryFeed({ treeId, leaf }: { treeId: string; leaf: Pick<Leaf, 'id' | 'status' | 'runId' | 'claim' | 'updatedAt'> }) {
  const [open, setOpen] = useState(false)
  const source = useWorkSource()
  const run = useQuery({ queryKey: keyedBy(source, groveKeys.run(treeId)), queryFn: () => source.getTreeRun(treeId), refetchInterval: source.pushed ? 10_000 : 3_000 })
  const turnId = run.data && 'turnId' in run.data ? run.data.turnId : undefined
  if (leaf.runId && run.isPending) return <Reading label="Finding the run that works it…" />
  if (!leaf.runId || !turnId) return null
  const working = leaf.status === 'running'

  return (
    <section aria-label="How it is worked" className="space-y-2" data-testid="story-feed">
      <button
        type="button"
        onClick={() => setOpen((shown) => !shown)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[12px] text-slate-300 hover:text-slate-100 cursor-pointer"
      >
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        {working && <Radio size={12} className="text-blue-400 animate-pulse" aria-hidden="true" />}
        {working ? 'Watch it work' : 'See how it was worked'}
      </button>
      {open && <Feed turnId={turnId} rootRunId={leaf.runId} asOf={working ? undefined : leaf.claim?.at ?? leaf.updatedAt} live={working} />}
    </section>
  )
}

const pickedByDefault = (runs: readonly RunInstance[]): RunInstance | undefined =>
  [...runs].reverse().find((run) => !run.finished) ?? runs.at(-1)

const POLLED_FEED_MS = 3_000

function Feed({ turnId, rootRunId, asOf, live }: { turnId: string; rootRunId: string; asOf?: string | undefined; live: boolean }) {
  const source = useWorkSource()
  const [runs, setRuns] = useState<RunInstance[]>([])
  const [events, setEvents] = useState<{ grouped: Record<string, EngineEvent[]>; latest: Record<string, string> }>({ grouped: {}, latest: {} })
  const [picked, setPicked] = useState<string>()
  const [error, setError] = useState<string | null>(null)
  const [caughtUp, setCaughtUp] = useState(false)
  const follower = useRef(createTurnFollower((turn, after) => source.readRunsUnder(turn, after, rootRunId)))
  const family = useRef(new Set([rootRunId]))
  const apply = useCallback((entry: TurnLogEntry) => {
    const kept = keptForStory(entry.events, family.current)
    if (kept.length === 0) return
    setRuns((current) => applyInstanceEvents(current, kept))
    setEvents((current) => withInstanceEvents(current.grouped, current.latest, kept))
  }, [])

  useEffect(() => {
    if (follower.current.following(turnId)) return
    void follower.current.follow(turnId, apply)
      .then(() => setCaughtUp(true))
      .catch((err) => setError(`Its run could not be read: ${errorMessage(err)}`))
  }, [turnId, apply])
  useSocketEvent<TurnLogEntry>(TURN_LOG_CHANNEL, (entry) => { if (source.pushed) follower.current.receive(entry, apply) })
  useEffect(() => {
    if (source.pushed || !live) return
    const timer = setInterval(() => {
      void follower.current.catchUp(turnId, apply).catch((err) => setError(`Its run could not be read: ${errorMessage(err)}`))
    }, POLLED_FEED_MS)
    return () => clearInterval(timer)
  }, [source.pushed, live, turnId, apply])

  const shown = instancesUnder(runs, rootRunId, asOf)
  if (error) return <p className="text-[12px] text-red-400">{error}</p>
  if (shown.length === 0 && !caughtUp) return <Reading label="Reading its run from the tree's log — a long run takes a few seconds…" />
  if (shown.length === 0) return <p className="text-[12px] text-slate-500">Nothing from its run has come in yet.</p>
  const chosen = shown.find((run) => run.key === picked) ?? pickedByDefault(shown)!
  return (
    <div className="space-y-2" data-testid="story-feed-runs">
      {shown.length > 1 && (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Its runs">
          {shown.map((run) => (
            <button
              key={run.key}
              type="button"
              role="tab"
              aria-selected={run.key === chosen.key}
              onClick={() => setPicked(run.key)}
              className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] cursor-pointer ${run.key === chosen.key ? 'border-[var(--leaf-stem)] bg-[var(--leaf-stem)]/15 text-slate-100' : 'border-[var(--bark-700)] text-slate-400 hover:text-slate-200'}`}
            >
              {!run.finished && <Radio size={10} className="text-blue-400 animate-pulse" aria-hidden="true" />}
              {run.agentId ?? run.runId}
              {run.finished && <span className={run.outcome === 'ok' ? 'text-emerald-400' : 'text-amber-400'}>· {run.outcome}</span>}
            </button>
          ))}
        </div>
      )}
      <StoryRun run={chosen} events={events.grouped[chosen.key] ?? []} />
    </div>
  )
}

export default StoryFeed
