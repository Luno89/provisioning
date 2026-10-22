import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, CircleDot, Cpu, Loader2, MessageSquare, Play, Square, Zap } from 'lucide-react'
import { listReleases, releaseKeys } from '../../../releases'
import { listProjectRuns } from '../../api/projects'
import { getTreeModels, getTreeRun, groveKeys, runTree, stopTreeRun, type TreeRunStatus } from '../../api/grove'
import { listModels, providerKeys } from '../../../../api/models'
import { useMachineChoiceLabels } from '../../../../api/local-agents'
import { errorMessage } from '../../../../api/client'
import { modelOptionLabel } from '../../../../lib/model-label'
import { ago } from '../../lib/home-summary'
import type { PipelineRun } from '../PipelineRunRow'
import type { Leaf } from '../../lib/leaf-types'
import AutoModeSwitch from '../../../../components/AutoMode/AutoModeSwitch'
import { useTreeAutoMode } from '../../../../components/AutoMode/useAutoMode'
import { OpenApp } from '../../../releases'
import { SignInReveal } from '../../../releases'
import { Decision } from '../../../releases'
import { TreeModels } from '../Workspace/TreeModels'
import TreeAsks from '../Workspace/TreeAsks'
import { TreeProposalsPanel } from '../Workspace/TreeProposalsPanel'
import { useTreeCards } from '../Workspace/useTreeCards'
import { projectStatus } from '../Board/board'
import { useProjectWork, type WorkTree } from '../../hooks/useProjectWork'
import { runsOnLine, workingOn } from './shared'
import { useRemembered } from '../../hooks/useChatPanel'

const chip = 'flex items-center gap-1.5 px-2 py-0.5 rounded border border-[var(--bark-700)] bg-[var(--bark-950,#090d0b)] text-[12px] cursor-pointer hover:bg-[var(--bark-800)]'

function LiveNow({ projectId }: { projectId: string }) {
  const releases = useQuery({ queryKey: releaseKeys.list(projectId), queryFn: () => listReleases(projectId), refetchInterval: 10_000 })
  const runs = useQuery<PipelineRun[]>({ queryKey: ['project-runs', projectId], queryFn: () => listProjectRuns<PipelineRun>(projectId) })
  const status = projectStatus(releases.data?.releases ?? [], runs.data ?? [])
  if (releases.isPending) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]" data-testid="strip-live">
      {status.live ? (
        <span className="flex items-center gap-1.5 text-slate-300">
          <CircleDot size={13} className="text-emerald-400" aria-hidden="true" />
          Live <span className="font-mono text-slate-100">{status.live.commit.slice(0, 8)}</span>
          {status.live.since && <span className="text-slate-500">{ago(status.live.since)}</span>}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-slate-500"><CircleDot size={13} aria-hidden="true" /> Nothing live yet</span>
      )}
      {status.live && <OpenApp projectId={projectId} />}
      {status.live && <SignInReveal projectId={projectId} />}
      {status.preparing && (
        <span className="flex items-center gap-1.5 text-sky-300">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Releasing <span className="font-mono">{status.preparing.commit.slice(0, 8)}</span>
        </span>
      )}
    </div>
  )
}

function lastRun(status: TreeRunStatus): string {
  switch (status.state) {
    case 'none': return 'Not run yet'
    case 'unavailable': return 'Cannot run right now: Temporal is not reachable'
    case 'failed': return `The last run stopped: ${status.reason}`
    case 'finished': return status.result.outcome === 'stopped' ? 'You stopped the last run' : 'Nothing left to work'
    case 'running': return ''
  }
}

function RunningNow({ tree, leaves, named }: { tree: WorkTree; leaves: readonly Leaf[]; named: boolean }) {
  const qc = useQueryClient()
  const { data: status } = useQuery({
    queryKey: groveKeys.run(tree.id),
    queryFn: () => getTreeRun(tree.id),
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 5_000 : 15_000),
  })
  const settled = () => {
    void qc.invalidateQueries({ queryKey: groveKeys.run(tree.id) })
    void qc.invalidateQueries({ queryKey: groveKeys.leaves() })
  }
  const run = useMutation({ mutationFn: () => runTree(tree.id), onSuccess: settled })
  const stop = useMutation({ mutationFn: () => stopTreeRun(tree.id), onSuccess: settled })
  if (!status) return null

  const ready = leaves.filter((leaf) => leaf.status === 'pending').length
  const working = workingOn(leaves)
  const prefix = named ? `${tree.name}: ` : ''

  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]" data-testid="strip-running">
      {status.state === 'running' ? (
        <>
          <span className="flex items-center gap-1.5 text-emerald-300">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            {prefix}{working.length ? `Working on ${working.map((title) => `“${title}”`).join(', ')}` : 'Starting the next story'}
          </span>
          <button type="button" onClick={() => stop.mutate()} disabled={stop.isPending} className={`${chip} text-rose-300`}>
            <Square size={11} /> Stop
          </button>
        </>
      ) : (
        <>
          <span className="text-slate-400">{prefix}{lastRun(status)}{ready > 0 ? ` · ${ready} ${ready === 1 ? 'story is' : 'stories are'} ready` : ''}</span>
          {ready > 0 && status.state !== 'unavailable' && (
            <button type="button" onClick={() => run.mutate()} disabled={run.isPending} className={`${chip} text-emerald-300`}>
              {run.isPending ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} Work them
            </button>
          )}
        </>
      )}
      {(run.error || stop.error) && <span className="text-red-400">{errorMessage(run.error ?? stop.error)}</span>}
    </div>
  )
}

function RunsOn({ tree, named, open, onToggle }: { tree: WorkTree; named: boolean; open: boolean; onToggle: () => void }) {
  const rows = useQuery({ queryKey: groveKeys.models(tree.id), queryFn: () => getTreeModels(tree.id) })
  const models = useQuery({ queryKey: providerKeys.list(), queryFn: listModels })
  const machines = useMachineChoiceLabels()
  const auto = useTreeAutoMode(tree.id)
  if (!rows.data || rows.data.length === 0) return null

  const nameOf = (modelId: string): string => {
    const machine = machines(modelId)
    if (machine) return machine
    const found = (models.data ?? []).find((model) => model.id === modelId)
    return found ? modelOptionLabel(found) : modelId
  }
  const line = runsOnLine(rows.data, nameOf)

  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className={chip} title="Which model or machine each agent in this tree works on, and whether it asks before it acts" data-testid="strip-runs-on">
      <Cpu size={12} className="text-emerald-400" aria-hidden="true" />
      <span className="text-slate-300 truncate max-w-[28rem]">{named ? `${tree.name}: ` : ''}{line.label}</span>
      {auto.on !== undefined && (
        <span className={`flex items-center gap-1 ${auto.on ? 'text-amber-300' : 'text-slate-500'}`}>
          · <Zap size={11} aria-hidden="true" /> {auto.on ? 'Auto mode on' : 'Asks first'}
        </span>
      )}
    </button>
  )
}

function RunsOnPanel({ tree }: { tree: WorkTree }) {
  return (
    <div className="rounded-md border border-[var(--bark-700)] bg-[var(--bark-950,#090d0b)] p-3 space-y-3 text-[12px]" data-testid="strip-runs-on-panel">
      <AutoModeSwitch
        state={useTreeAutoMode(tree.id)}
        label="Auto mode"
        explain="Runs working on this tree never stop to ask you before a call. Calls inside its sandbox never ask anyway."
      />
      <TreeModels treeId={tree.id} />
    </div>
  )
}

function TreeWaiting({ tree, named }: { tree: WorkTree; named: boolean }) {
  const cards = useTreeCards(tree.id)
  const { data: status } = useQuery({ queryKey: groveKeys.run(tree.id), queryFn: () => getTreeRun(tree.id) })
  const asks = status?.state === 'running' ? status.asking ?? [] : []
  if (cards.open.length === 0 && cards.waiting.length === 0 && cards.pending.length === 0 && cards.asking.length === 0 && asks.length === 0) return null
  return (
    <div className="space-y-2" data-testid="strip-waiting-tree">
      {named && <div className="text-[11px] text-slate-500">{tree.name}</div>}
      <TreeAsks asks={asks} />
      <div className="max-h-[40vh] overflow-y-auto rounded-md">
        <TreeProposalsPanel treeId={tree.id} quietWhenEmpty />
      </div>
    </div>
  )
}

function PreviewWaiting({ projectId }: { projectId: string }) {
  const releases = useQuery({ queryKey: releaseKeys.list(projectId), queryFn: () => listReleases(projectId), refetchInterval: 10_000 })
  const preview = projectStatus(releases.data?.releases ?? [], []).preview
  if (!preview) return null
  return <Decision projectId={projectId} release={preview} preview={releases.data?.addresses.preview} />
}

function WaitingCount({ trees, projectId }: { trees: readonly WorkTree[]; projectId: string | undefined }) {
  return (
    <>
      {trees.map((tree) => <TreeCount key={tree.id} treeId={tree.id} />)}
      {projectId && <PreviewCount projectId={projectId} />}
    </>
  )
}

function TreeCount({ treeId }: { treeId: string }) {
  const cards = useTreeCards(treeId)
  const { data: status } = useQuery({ queryKey: groveKeys.run(treeId), queryFn: () => getTreeRun(treeId) })
  const asks = status?.state === 'running' ? status.asking?.length ?? 0 : 0
  return <Counted n={cards.count + asks} />
}

function PreviewCount({ projectId }: { projectId: string }) {
  const releases = useQuery({ queryKey: releaseKeys.list(projectId), queryFn: () => listReleases(projectId), refetchInterval: 10_000 })
  return <Counted n={projectStatus(releases.data?.releases ?? [], []).preview ? 1 : 0} />
}

const Counted = ({ n }: { n: number }) => (n > 0 ? <span data-waiting={n} hidden /> : null)

export interface StripChannel {
  open: boolean
  onToggle: () => void
}

export default function ProjectStrip({ treeId, projectId, channel }: { treeId?: string | undefined; projectId?: string | undefined; channel?: StripChannel | undefined }) {
  const { tree, project, projectTrees, branches, leaves } = useProjectWork({ treeId, projectId })
  const [modelsOpen, setModelsOpen] = useState<string | undefined>(undefined)
  const waiting = useRemembered('project-waiting-closed', `${treeId ?? ''}|${projectId ?? ''}`)
  const named = projectTrees.length > 1
  const title = project?.name ?? tree?.name
  const leavesOf = (id: string): Leaf[] => {
    const own = new Set(branches.filter((branch) => branch.treeId === id).map((branch) => branch.id))
    return leaves.filter((leaf) => own.has(leaf.branchId))
  }
  const openTree = projectTrees.find((entry) => entry.id === modelsOpen)

  return (
    <section className="shrink-0 mb-3 rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] p-3 space-y-2" aria-label="What is going on" data-testid="project-strip">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {title && <h1 className="text-[15px] font-semibold text-slate-100 break-words mr-1">{title}</h1>}
        {project && <LiveNow projectId={project.id} />}
        {projectTrees.map((entry) => <RunningNow key={entry.id} tree={entry} leaves={leavesOf(entry.id)} named={named} />)}
        {projectTrees.map((entry) => (
          <RunsOn key={entry.id} tree={entry} named={named} open={modelsOpen === entry.id} onToggle={() => setModelsOpen(modelsOpen === entry.id ? undefined : entry.id)} />
        ))}
        {channel && (
          <button type="button" onClick={channel.onToggle} aria-pressed={channel.open} className={`${chip} ml-auto ${channel.open ? 'text-emerald-300' : 'text-slate-300'}`} data-testid="strip-channel">
            <MessageSquare size={12} aria-hidden="true" /> {channel.open ? 'Hide the channel' : 'Channel'}
          </button>
        )}
      </div>
      {openTree && <RunsOnPanel tree={openTree} />}
      <div className="hidden has-[[data-waiting]]:block space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2" data-testid="strip-waiting">
        <button type="button" onClick={waiting.toggle} aria-expanded={waiting.open} className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-amber-300 cursor-pointer">
          {waiting.open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />} Waiting on you
        </button>
        <WaitingCount trees={projectTrees} projectId={project?.id} />
        {waiting.open && project && <PreviewWaiting projectId={project.id} />}
        {waiting.open && projectTrees.map((entry) => <TreeWaiting key={entry.id} tree={entry} named={named} />)}
      </div>
    </section>
  )
}
