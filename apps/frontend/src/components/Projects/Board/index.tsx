import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquarePlus, PanelRightOpen } from 'lucide-react'
import ChatSurface from '../../ChatSurface'
import LeafDetail from '../../LeafDetail'
import { chatPackKeys, createChatConversation, type ConversationBinding } from '../../../api/chat-pack'
import { engineKeys, listTasks } from '../../../api/engine'
import { listReleases, releaseKeys } from '../../../api/releases'
import { listProjectRuns } from '../../../api/projects'
import type { PipelineRun } from '../../PipelineRunRow'
import { ProjectChannel } from '../Workspace/ProjectChannel'
import { TreeConversationsPanel } from '../Workspace/TreeConversationsPanel'
import { TreeRunPanel } from '../Workspace/TreeRunPanel'
import TreeAsks from '../Workspace/TreeAsks'
import { getTreeRun, groveKeys, listTreeTypes, type TreeAsk, type TreeRunStatus } from '../../../api/grove'
import type { LeafStatus } from '../../leaf-types'
import { TreeProposalsPanel } from '../Workspace/TreeProposalsPanel'
import { useResizableWidth } from '../Workspace/useResizableWidth'
import { resizeHandle } from '../Workspace/shared'
import { useProjectWork } from '../useProjectWork'
import Reading from '../Reading'
import { useRouteSync } from '../useRouteSync'
import { buildBoard, byRank, featureOnly, type Epic } from './board'
import { StoryTasks } from './StoryTasks'
import { StoryFeed } from './StoryFeed'
import { useBoardOrder } from './useBoardOrder'
import { StatusBar } from './StatusBar'
import { Swimlanes } from './Swimlanes'
import { ItemChat } from './ItemChat'
import { Breadcrumbs, type Crumb } from './Breadcrumbs'
import type { StoryAddress } from '../../Chat/ChatNotice'

const STARTABLE: ReadonlySet<LeafStatus> = new Set(['pending', 'running', 'claimed'])

type Main = { kind: 'board'; epicId?: string | undefined } | { kind: 'story'; id: string } | { kind: 'feature'; id: string }
type Side = { kind: 'item' } | { kind: 'channel' } | { kind: 'threads' } | { kind: 'conversation'; id: string }

const mainFrom = (branchId: string | undefined, leafId: string | undefined): Main =>
  leafId ? { kind: 'story', id: leafId } : branchId ? { kind: 'feature', id: branchId } : { kind: 'board' }

const tab = (on: boolean) => `px-2 py-1 rounded-md cursor-pointer whitespace-nowrap ${on ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400 hover:text-slate-200'}`

const askingOf = (runs: readonly { data?: TreeRunStatus | undefined }[]): TreeAsk[] =>
  runs.flatMap((run) => (run.data?.state === 'running' ? run.data.asking ?? [] : []))

export function ProjectBoard({ treeId, projectId, initialBranchId, initialLeafId, onTreeReady }: {
  treeId?: string | undefined
  projectId?: string | undefined
  initialBranchId?: string | undefined
  initialLeafId?: string | undefined
  onTreeReady?: ((treeId: string) => void) | undefined
}) {
  const qc = useQueryClient()
  const { branches, leaves, tree, project, projectTrees, reading } = useProjectWork({ treeId, projectId })

  const [main, setMain] = useState<Main>(() => mainFrom(initialBranchId, initialLeafId))
  const [sideChoice, setSideChoice] = useState<Side | undefined>(undefined)
  const addressed = `${initialBranchId ?? ''}|${initialLeafId ?? ''}`
  const [seenAddress, setSeenAddress] = useState(addressed)
  if (addressed !== seenAddress) {
    setSeenAddress(addressed)
    setMain(mainFrom(initialBranchId, initialLeafId))
    setSideChoice(undefined)
  }
  const go = (next: Main) => {
    setMain(next)
    setSideChoice(undefined)
  }

  const itemOpen = main.kind !== 'board'
  const home: Side = project ? { kind: 'channel' } : { kind: 'threads' }
  const side: Side = sideChoice ?? (itemOpen ? { kind: 'item' } : home)

  const tasks = useQuery({ queryKey: engineKeys.tasks(), queryFn: listTasks, refetchInterval: 10_000 })
  const releases = useQuery({ queryKey: releaseKeys.list(project?.id ?? ''), queryFn: () => listReleases(project!.id), enabled: Boolean(project), refetchInterval: 10_000 })
  const runs = useQuery<PipelineRun[]>({ queryKey: ['project-runs', project?.id ?? ''], queryFn: () => listProjectRuns<PipelineRun>(project!.id), enabled: Boolean(project) })

  const asking = useQueries({
    queries: projectTrees.map((entry) => ({ queryKey: groveKeys.run(entry.id), queryFn: () => getTreeRun(entry.id), refetchInterval: 10_000 })),
    combine: askingOf,
  })

  const treeTypes = useQuery({ queryKey: groveKeys.treeTypes(), queryFn: listTreeTypes, staleTime: Infinity })
  const epics = useMemo(() => buildBoard({
    trees: projectTrees,
    types: treeTypes.data,
    branches,
    leaves,
    tasks: tasks.data,
    releases: releases.data?.releases,
    runs: runs.data,
    asking,
  }), [projectTrees, treeTypes.data, branches, leaves, tasks.data, releases.data, runs.data, asking])

  const order = useBoardOrder()
  const openLeaf = main.kind === 'story' ? leaves.find((leaf) => leaf.id === main.id) : undefined
  const featureId = main.kind === 'feature' ? main.id : openLeaf?.branchId
  const openBranch = featureId ? branches.find((branch) => branch.id === featureId) : undefined
  const openEpic: Epic | undefined = openBranch ? epics.find((epic) => epic.id === openBranch.treeId) : undefined
  const openFeature = openEpic?.features.find((feature) => feature.id === featureId)

  const itemUnread = main.kind !== 'board' && !openBranch
  useRouteSync(
    itemUnread ? undefined : tree
      ? {
          kind: 'tree',
          treeId: tree.id,
          ...(openBranch && openBranch.treeId === tree.id
            ? { branchId: openBranch.id, ...(openLeaf ? { leafId: openLeaf.id } : {}) }
            : {}),
        }
      : project ? { kind: 'project', projectId: project.id } : undefined,
  )

  const mainRef = useRef<HTMLDivElement>(null)
  const mainKey = main.kind === 'board' ? `board:${main.epicId ?? ''}` : `${main.kind}:${main.id}`
  useEffect(() => {
    const at = mainRef.current
    if (!at) return
    const epicId = mainKey.startsWith('board:') ? mainKey.slice('board:'.length) : ''
    const epic = epicId ? Array.from(at.querySelectorAll<HTMLElement>('[data-epic]')).find((section) => section.dataset.epic === epicId) : undefined
    if (epic) epic.scrollIntoView?.({ block: 'start' })
    else at.scrollTop = 0
  }, [mainKey])

  const binding: ConversationBinding | undefined = treeId ? { treeId } : project ? { projectId: project.id } : undefined
  const openChat = useMutation({
    mutationFn: () => createChatConversation('New conversation', binding),
    onSuccess: (conversation) => {
      setSideChoice({ kind: 'conversation', id: conversation.id })
      void qc.invalidateQueries({ queryKey: chatPackKeys.conversations() })
    },
  })

  const openTree = (id: string) => { if (id !== treeId) onTreeReady?.(id) }
  const openStory = (story: StoryAddress) => go({ kind: 'story', id: story.leafId })

  const boardRef = useRef<HTMLDivElement>(null)
  const sidePanel = useResizableWidth(
    'board-side-width',
    416,
    300,
    () => Math.max(320, (boardRef.current?.clientWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1200)) - 480),
  )

  const title = project?.name ?? tree?.name ?? 'Board'
  const crumbs: Crumb[] = [
    { label: title, onOpen: () => go({ kind: 'board' }) },
    ...(openEpic && (epics.length > 1 || openEpic.name !== title) ? [{ label: openEpic.name, onOpen: () => go({ kind: 'board', epicId: openEpic.id }) }] : []),
    ...(openBranch ? [{ label: openBranch.title, onOpen: () => go({ kind: 'feature', id: openBranch.id }) }] : []),
    ...(openLeaf ? [{ label: openLeaf.title }] : []),
  ]

  const itemLabel = main.kind === 'story' ? 'Story chat' : 'Feature chat'
  const sideTitle = side.kind === 'item' ? itemLabel : side.kind === 'channel' ? 'Channel' : side.kind === 'conversation' ? 'Thread' : 'Threads'

  return (
    <div
      ref={boardRef}
      className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3 lg:gap-0"
      style={{ ['--board-side' as string]: `${sidePanel.width}px` }}
      data-testid="project-board"
    >
      <div ref={mainRef} className="flex-1 min-w-0 min-h-0 flex flex-col gap-3 overflow-y-auto" data-testid="board-main">
        {main.kind === 'board' && (
          <>
            <header className="space-y-2 rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] p-3">
              <h1 className="text-[15px] font-semibold text-slate-100 break-words">{title}</h1>
              {project && <StatusBar projectId={project.id} />}
            </header>

            {reading && <Reading label="Reading its features and stories…" className="px-1 py-2" />}

            {!reading && epics.length === 0 && project && (
              <div className="rounded-lg border border-dashed border-[var(--bark-600)] p-6 flex flex-col items-center gap-3 text-center text-slate-400">
                <MessageSquarePlus size={24} className="text-slate-600" aria-hidden="true" />
                <p className="text-[13px] max-w-md">No work planned yet. Plan it with Koala in its own conversation; once you approve the plan, its features and stories appear here.</p>
                <button
                  type="button"
                  onClick={() => openChat.mutate()}
                  disabled={openChat.isPending || !binding}
                  className="text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white cursor-pointer disabled:opacity-50"
                >
                  Start a conversation
                </button>
              </div>
            )}

            {!reading && epics.map((epic) => (
              <section key={epic.id} data-epic={epic.id} className="rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] p-3 space-y-2" aria-label={epic.name} data-testid="epic">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="text-[13px] font-semibold text-slate-200 break-words">{epic.name}</h2>
                  {epic.version && <span className="text-[11px] px-1.5 rounded bg-[var(--bark-800)] text-slate-300" data-testid="epic-version">{epic.version}</span>}
                  <span className="text-[11px] text-slate-500">
                    {epic.features.length} {epic.features.length === 1 ? 'feature' : 'features'}, {epic.total} {epic.total === 1 ? 'story' : 'stories'} · <span className="text-[var(--leaf)]">{epic.totals.verified} verified</span>
                  </span>
                </div>
                <TreeProposalsPanel treeId={epic.id} quietWhenEmpty />
                <TreeRunPanel treeId={epic.id} />
                {order.error && <p className="text-[11px] text-red-400" role="alert">{order.error}</p>}
                <Swimlanes
                  epic={epic}
                  onOpenLeaf={(id) => go({ kind: 'story', id })}
                  onOpenFeature={(id) => go({ kind: 'feature', id })}
                  onOrderStories={order.orderStories}
                  onOrderFeatures={(branchIds) => order.orderFeatures(epic.id, branchIds)}
                />
              </section>
            ))}
          </>
        )}

        {itemOpen && (
          <div className="rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] px-3 py-2 shrink-0">
            <Breadcrumbs crumbs={crumbs} />
          </div>
        )}

        {main.kind === 'story' && openLeaf && (
          <article className="rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] p-4" aria-label={openLeaf.title} data-testid="story-page">
            <LeafDetail key={openLeaf.id} leaf={openLeaf} all={leaves} treeId={openBranch?.treeId} />
            {asking.some((ask) => ask.leafId === openLeaf.id) && <div className="mt-3"><TreeAsks asks={asking.filter((ask) => ask.leafId === openLeaf.id)} /></div>}
            {openBranch?.treeId && STARTABLE.has(openLeaf.status) && (
              <div className="mt-4 rounded-md border border-[var(--bark-700)]" data-testid="story-run-tree">
                <TreeRunPanel treeId={openBranch.treeId} />
                <p className="px-3 pb-2 text-[11px] text-slate-500">This story is worked by running its tree, which takes the stories that are ready in the order you set on the board.</p>
              </div>
            )}
            {openBranch?.treeId && (
              <div className="mt-4">
                <StoryFeed treeId={openBranch.treeId} leaf={openLeaf} />
              </div>
            )}
            <div className="mt-4">
              <StoryTasks tasks={(tasks.data ?? []).filter((task) => task.leafId === openLeaf.id).sort((a, b) => (openLeaf.tasks ?? []).indexOf(a.id) - (openLeaf.tasks ?? []).indexOf(b.id) || byRank(a, b))} />
            </div>
          </article>
        )}
        {main.kind === 'story' && !openLeaf && reading && <Reading label="Opening the story…" className="p-3" />}
        {main.kind === 'story' && !openLeaf && !reading && <p className="p-3 text-[12px] text-slate-500">This story is no longer on the board.</p>}

        {main.kind === 'feature' && openFeature && openEpic && (
          <article className="rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] p-4 space-y-3" aria-label={openFeature.title} data-testid="feature-page">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold text-slate-100 break-words">{openFeature.title}</h2>
              <p className="text-[12px] text-slate-500">{openFeature.total} {openFeature.total === 1 ? 'story' : 'stories'} · {openFeature.columns.verified.length} verified · {openFeature.columns.failed.length} failed</p>
            </div>
            <Swimlanes
              epic={featureOnly(openEpic, openFeature)}
              selectedFeatureId={openFeature.id}
              onOpenLeaf={(id) => go({ kind: 'story', id })}
              onOpenFeature={(id) => go({ kind: 'feature', id })}
              onOrderStories={order.orderStories}
            />
            {order.error && <p className="text-[11px] text-red-400" role="alert">{order.error}</p>}
          </article>
        )}
        {main.kind === 'feature' && !openFeature && reading && <Reading label="Opening the feature…" className="p-3" />}
        {main.kind === 'feature' && !openFeature && !reading && <p className="p-3 text-[12px] text-slate-500">This feature is no longer on the board.</p>}
      </div>

      {sidePanel.isCollapsed ? (
        <div className="hidden lg:flex shrink-0 ml-3 flex-col items-center py-2 px-1 rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)]">
          <button
            type="button"
            onClick={sidePanel.toggleCollapse}
            title={`Show the ${sideTitle.toLowerCase()}`}
            aria-label="Expand right panel"
            className="p-1.5 rounded-lg hover:bg-[var(--bark-700)] text-slate-400 hover:text-slate-100 cursor-pointer"
          >
            <PanelRightOpen size={16} />
          </button>
        </div>
      ) : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the chat panel"
          onMouseDown={sidePanel.startResize(-1)}
          onDoubleClick={sidePanel.toggleCollapse}
          title="Drag to resize, double-click to collapse"
          className={`hidden lg:block ${resizeHandle}`}
        />
      )}

      <aside
        className={`lg:w-[var(--board-side)] lg:max-w-[calc(100%-30rem)] shrink-0 min-h-[24rem] flex-col rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] overflow-hidden ${sidePanel.isCollapsed ? 'flex lg:hidden' : 'flex'}`}
        aria-label={sideTitle}
      >
        <div role="tablist" aria-label="Chat" className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--bark-700)] text-[12px] shrink-0 overflow-x-auto">
          {itemOpen && (
            <button type="button" role="tab" aria-selected={side.kind === 'item'} onClick={() => setSideChoice({ kind: 'item' })} className={tab(side.kind === 'item')}>
              {itemLabel}
            </button>
          )}
          {project && (
            <button type="button" role="tab" aria-selected={side.kind === 'channel'} onClick={() => setSideChoice({ kind: 'channel' })} className={tab(side.kind === 'channel')}>
              Channel
            </button>
          )}
          {binding && (
            <button type="button" role="tab" aria-selected={side.kind === 'threads' || side.kind === 'conversation'} onClick={() => setSideChoice({ kind: 'threads' })} className={tab(side.kind === 'threads' || side.kind === 'conversation')}>
              Threads
            </button>
          )}
        </div>
        {side.kind === 'conversation' && (
          <button type="button" onClick={() => setSideChoice({ kind: 'threads' })} className="shrink-0 text-left px-3 py-1 text-[11px] text-emerald-300 hover:underline cursor-pointer border-b border-[var(--bark-700)]">
            ← Threads
          </button>
        )}
        <div className={`flex-1 min-h-0 ${side.kind === 'threads' ? 'overflow-y-auto p-3' : side.kind === 'item' ? 'flex flex-col' : ''}`}>
          {side.kind === 'channel' && project && (
            <ProjectChannel projectId={project.id} onOpenTree={openTree} onOpenStory={openStory} />
          )}
          {side.kind === 'threads' && binding && (
            <TreeConversationsPanel
              binding={binding}
              selected={{ kind: 'tree', id: treeId ?? '' }}
              onSelect={(id) => setSideChoice({ kind: 'conversation', id })}
              onNew={() => openChat.mutate()}
              creating={openChat.isPending}
            />
          )}
          {side.kind === 'conversation' && binding && (
            <ChatSurface key={side.id} conversationId={side.id} binding={binding} hideSidebar onOpenTree={openTree} onOpenStory={openStory} />
          )}
          {side.kind === 'item' && main.kind === 'story' && openLeaf && (
            <div className="flex-1 min-h-0">
              <ItemChat
                key={openLeaf.id}
                kind="story"
                id={openLeaf.id}
                intro={<p className="text-[12px]">Ask Koala about &ldquo;{openLeaf.title}&rdquo;.</p>}
                onOpenTree={openTree}
                onOpenStory={openStory}
              />
            </div>
          )}
          {side.kind === 'item' && main.kind === 'feature' && openFeature && (
            <div className="flex-1 min-h-0">
              <ItemChat
                key={openFeature.id}
                kind="feature"
                id={openFeature.id}
                intro={<p className="text-[12px]">Ask Koala about the feature &ldquo;{openFeature.title}&rdquo;.</p>}
                onOpenTree={openTree}
                onOpenStory={openStory}
              />
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

export default ProjectBoard
