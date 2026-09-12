import { useState, useMemo, useEffect, useRef, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown, ChevronRight, AlertTriangle, MessageSquarePlus,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Folder, MessageSquare,
} from 'lucide-react'
import BranchChat, { type BranchRecord } from '../../BranchChat.js'
import { type ChatAttachment } from '../../ChatSurface.js'
import Home from '../../Home.js'
import LeafDetail from '../../LeafDetail.js'
import NewTreeDialog from '../../NewTreeDialog.js'
import { type Leaf } from '../../leaf-types.js'
import { type ChatMessageRecord as Message } from '../../ChatSurface.js'
import {
  listTrees, listBranches, listLeaves, patchBranch, patchTree, acceptLeaf, groveKeys,
  createBranch as apiCreateBranch,
  deleteBranch as apiDeleteBranch,
  deleteLeaf as apiDeleteLeaf,
} from '../../../api/grove.js'
import { listPacks } from '../../../api/packs.js'
import { listProjects, projectKeys } from '../../../api/projects.js'
import { lastSeen, markSeenAfterDwell } from '../../../lib/seen.js'
import { findLinkedProject } from '../../../lib/tree-project-link.js'
import { parseHash, formatHash, shouldReplace } from '../../../lib/route.js'
import { FileTree } from '../../ProjectEditor/FileTree.js'
import { EditorPane } from '../../ProjectEditor/EditorPane.js'
import { TabBar } from '../../ProjectEditor/TabBar.js'
import { useOpenFiles } from '../../ProjectEditor/useOpenFiles.js'
import { isDirty } from '../../ProjectEditor/shared.js'
import { BuildsDeploysPanel } from './BuildsDeploysPanel.js'
import { BranchesPanel } from './BranchesPanel.js'
import { panel, resizeHandle, type SelectedEntity } from './shared.js'
import { useResizableWidth } from './useResizableWidth.js'

interface WorkspaceTree {
  id: string
  name: string
  goal?: string
  projectIds?: string[]
}

function CollapsibleSection({ title, defaultOpen = true, isOpen, onToggle, children }: {
  title: string
  defaultOpen?: boolean
  isOpen?: boolean
  onToggle?: (next: boolean) => void
  children: ReactNode
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const open = isOpen !== undefined ? isOpen : internalOpen
  const toggle = () => {
    if (onToggle) onToggle(!open)
    else setInternalOpen(!open)
  }
  return (
    <div className="border-t border-[var(--bark-700)] shrink-0 max-h-[45%] flex flex-col">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-300 shrink-0 cursor-pointer"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
      </button>
      {open && <div className="overflow-y-auto min-h-0">{children}</div>}
    </div>
  )
}

export function Workspace({
  treeId, projectId, initialBranchId, initialLeafId, onTreeReady, handoff, onHandoffTaken,
}: {
  treeId?: string | undefined
  projectId?: string | undefined
  initialBranchId?: string | undefined
  initialLeafId?: string | undefined
  onTreeReady?: ((treeId: string) => void) | undefined
  handoff?: { branchId: string; prompt: string } | undefined
  onHandoffTaken?: (() => void) | undefined
}) {
  const qc = useQueryClient()

  const [selected, setSelected] = useState<SelectedEntity>(() => {
    if (initialLeafId) return { kind: 'leaf', id: initialLeafId }
    if (initialBranchId ?? handoff?.branchId) return { kind: 'branch', id: initialBranchId ?? handoff!.branchId }
    return { kind: 'tree', id: treeId ?? '' }
  })
  const [branchesOpen, setBranchesOpen] = useState(() => selected.kind !== 'branch')
  const selectBranch = (id: string) => {
    setSelected({ kind: 'branch', id })
    setBranchesOpen(false)
  }
  const openedHandoffRef = useRef<string | null>(handoff?.branchId ?? null)
  useEffect(() => {
    if (!handoff || openedHandoffRef.current === handoff.branchId) return
    openedHandoffRef.current = handoff.branchId
    selectBranch(handoff.branchId)
  }, [handoff])

  useEffect(() => {
    if (initialLeafId) {
      setSelected({ kind: 'leaf', id: initialLeafId })
    } else if (initialBranchId) {
      selectBranch(initialBranchId)
    }
  }, [initialBranchId, initialLeafId])
  const [transcripts, setTranscripts] = useState<Record<string, Message[]>>({})
  const [modes, setModes] = useState<Record<string, 'chat' | 'auto' | 'plan'>>({})
  const [opening, setOpening] = useState<{ branchId: string; prompt: string } | undefined>()
  const [showNewTree, setShowNewTree] = useState(false)
  const [promotingBranchId, setPromotingBranchId] = useState<string | null>(null)
  const [acceptError, setAcceptError] = useState<string | null>(null)

  const seenAt = useRef<string | undefined>(lastSeen('grove-seen'))
  useEffect(() => markSeenAfterDwell('grove-seen'), [])

  const { data: trees = [] } = useQuery<WorkspaceTree[]>({
    queryKey: groveKeys.trees(),
    queryFn: () => listTrees() as Promise<WorkspaceTree[]>,
  })
  const { data: branchRecords = [] } = useQuery<BranchRecord[]>({
    queryKey: ['branches'],
    queryFn: () => listBranches() as Promise<BranchRecord[]>,
    refetchInterval: 10000,
  })
  const { data: leaves = [] } = useQuery<Leaf[]>({
    queryKey: ['leaves'],
    queryFn: listLeaves,
    refetchInterval: 5000,
  })
  const { data: packs = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['packs'],
    queryFn: listPacks,
    staleTime: 60_000,
  })
  const { data: projects = [] } = useQuery<any[]>({
    queryKey: projectKeys.list(),
    queryFn: () => listProjects<any>(),
    staleTime: 10_000,
  })

  const tree = treeId ? trees.find((t) => t.id === treeId) : undefined
  const project = tree ? findLinkedProject(tree, projects) : projects.find((p) => p.id === projectId)
  const hasTree = Boolean(tree)
  const hasProject = Boolean(project)

  const treeBranches = useMemo(
    () => branchRecords.filter((b) => (treeId ? b.treeId === treeId : Boolean(project) && b.projectId === project?.id)),
    [branchRecords, treeId, project],
  )

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['leaves'] })
    qc.invalidateQueries({ queryKey: ['branches'] })
  }

  const createBranch = useMutation({
    mutationFn: () => apiCreateBranch<BranchRecord>(treeId ? { treeId } : project ? { projectId: project.id } : {}),
    onSuccess: (branch: BranchRecord) => {
      selectBranch(branch.id)
      qc.invalidateQueries({ queryKey: ['branches'] })
    },
  })
  const startWork = useMutation({
    mutationFn: (_args: { prompt: string }) =>
      apiCreateBranch<BranchRecord>(treeId ? { treeId } : project ? { projectId: project.id } : {}),
    onSuccess: (branch, { prompt }) => {
      selectBranch(branch.id)
      setOpening({ branchId: branch.id, prompt })
      qc.invalidateQueries({ queryKey: ['branches'] })
    },
  })
  const deleteBranch = useMutation({
    mutationFn: (id: string) => apiDeleteBranch(id),
    onSuccess: (_, id) => {
      setTranscripts((prev) => { const copy = { ...prev }; delete copy[id]; return copy })
      if (selected.kind === 'branch' && selected.id === id) setSelected({ kind: 'tree', id: treeId ?? '' })
      refresh()
    },
  })
  const refusal = (err: any) => err?.response?.data?.error ?? err?.message ?? 'That could not be accepted.'
  const accept = useMutation({
    mutationFn: (id: string) => acceptLeaf(id),
    onSuccess: () => { setAcceptError(null); refresh() },
    onError: (err) => setAcceptError(refusal(err)),
  })
  const reject = useMutation({
    mutationFn: (id: string) => apiDeleteLeaf(id),
    onSuccess: refresh,
  })
  const acceptAll = useMutation({
    mutationFn: async (ids: string[]) => {
      let failed: string | null = null
      for (const id of ids) {
        await acceptLeaf(id).catch((err) => { if (!failed) failed = refusal(err) })
      }
      setAcceptError(failed)
    },
    onSuccess: refresh,
  })

  const linkTree = useMutation({
    mutationFn: (newTreeId: string) => patchTree(newTreeId, { projectId }),
    onSuccess: (_r, newTreeId) => {
      qc.invalidateQueries({ queryKey: groveKeys.trees() })
      onTreeReady?.(newTreeId)
    },
  })

  const childrenOf = (leafId: string) => leaves.filter((l) => l.parentLeafId === leafId)
  const selectedLeaf = selected.kind === 'leaf' ? leaves.find((l) => l.id === selected.id) : undefined
  const selectedBranch = selected.kind === 'branch'
    ? treeBranches.find((b) => b.id === selected.id)
      ?? ({ id: selected.id, title: 'Conversation', messages: [], updatedAt: '' } as BranchRecord)
    : undefined

  const router = useRouter({ warn: false })

  useEffect(() => {
    if (!treeId) return
    const branchId = selected.kind === 'branch' ? selected.id : selectedLeaf?.branchId ?? ''
    const leafId = selected.kind === 'leaf' ? selected.id : ''
    const path = ['tree', treeId, branchId, leafId].filter(Boolean)
    const hash = formatHash('projects', path)
    if (window.location.hash === hash) return
    const current = parseHash(window.location.hash)
    const next = { view: 'projects', path }
    const replace = shouldReplace(current, next)
    if (replace) window.history.replaceState(null, '', hash)
    else window.history.pushState(null, '', hash)

    if (router) {
      if (branchId && leafId) {
        router.navigate({ to: '/projects/tree/$treeId/$branchId/$leafId', params: { treeId, branchId, leafId }, replace }).catch(() => {})
      } else if (branchId) {
        router.navigate({ to: '/projects/tree/$treeId/$branchId', params: { treeId, branchId }, replace }).catch(() => {})
      } else {
        router.navigate({ to: '/projects/tree/$treeId', params: { treeId }, replace }).catch(() => {})
      }
    }
  }, [treeId, selected, selectedLeaf, router])

  const projectId_ = project?.id ?? ''
  const {
    openFiles, activePath, setActivePath, active,
    loadingPath, savingPath, conflictPath,
    loadFile, openFile, closeFile, changeContent, saveFile,
  } = useOpenFiles(projectId_)

  const [manualAttachments, setManualAttachments] = useState<ChatAttachment[]>([])
  const [dismissedActivePath, setDismissedActivePath] = useState<string | null>(null)
  const attachments = useMemo(() => {
    const list = [...manualAttachments]
    if (active?.path && active.path !== dismissedActivePath && !list.some((a) => a.path === active.path)) {
      list.unshift({ path: active.path, type: 'file' })
    }
    return list
  }, [manualAttachments, active?.path, dismissedActivePath])
  const attachPath = (path: string, type: 'file' | 'dir') => {
    setManualAttachments((prev) => (prev.some((a) => a.path === path) ? prev : [...prev, { path, type }]))
  }
  const removeAttachment = (path: string) => {
    setManualAttachments((prev) => prev.filter((a) => a.path !== path))
    if (path === active?.path) setDismissedActivePath(path)
  }

  const leftPanel = useResizableWidth(
    'workspace-left-width',
    256,
    180,
    () => Math.max(800, (typeof window !== 'undefined' ? window.innerWidth : 1200) - (rightPanel.isCollapsed ? 60 : rightPanel.width) - 160),
  )
  const rightPanel = useResizableWidth(
    'workspace-right-width',
    384,
    260,
    () => Math.max(900, (typeof window !== 'undefined' ? window.innerWidth : 1200) - (leftPanel.isCollapsed ? 60 : leftPanel.width) - 160),
  )

  return (
    <div className="flex-1 min-h-0 flex gap-0 relative">
      {acceptError && (
        <div className="absolute top-0 left-0 right-0 z-30 m-2 rounded-xl border border-amber-500/40 bg-amber-950/60 px-4 py-2.5 flex items-start gap-3">
          <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[12px] text-amber-100 leading-relaxed flex-1">{acceptError}</p>
          <button onClick={() => setAcceptError(null)} className="text-amber-400/70 hover:text-amber-200 text-[11px]">dismiss</button>
        </div>
      )}

      {hasProject && (
        leftPanel.isCollapsed ? (
          <div
            className="shrink-0 flex flex-col items-center py-2 px-1 bg-[var(--bark-800)] border border-[var(--bark-700)] rounded-xl select-none"
            data-testid="left-panel-collapsed"
          >
            <button
              type="button"
              onClick={leftPanel.toggleCollapse}
              title="Expand Explorer (Files & Builds)"
              aria-label="Expand left panel"
              className="p-1.5 rounded-lg hover:bg-[var(--bark-700)] text-slate-400 hover:text-slate-100 transition-colors cursor-pointer"
            >
              <PanelLeftOpen size={16} />
            </button>
            <span
              className="mt-4 text-[10px] font-semibold text-slate-500 uppercase tracking-widest cursor-pointer hover:text-slate-300"
              style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
              onClick={leftPanel.toggleCollapse}
            >
              Explorer
            </span>
          </div>
        ) : (
          <div className={`${panel} shrink-0 flex flex-col overflow-hidden`} style={{ width: leftPanel.width }}>
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--bark-700)] shrink-0 bg-[var(--bark-900)]/40">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                <Folder size={13} className="text-sky-400" />
                <span>Explorer</span>
              </div>
              <button
                type="button"
                onClick={leftPanel.toggleCollapse}
                title="Collapse left panel"
                aria-label="Collapse left panel"
                className="p-1 rounded hover:bg-[var(--bark-700)] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              >
                <PanelLeftClose size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 min-h-0">
              <FileTree projectId={projectId_} activePath={activePath} onOpen={(path) => void openFile(path)} onAttach={attachPath} />
            </div>
            <CollapsibleSection title="Builds & Deploys">
              <BuildsDeploysPanel project={project} />
            </CollapsibleSection>
          </div>
        )
      )}

      {hasProject && !leftPanel.isCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file panel"
          onMouseDown={leftPanel.startResize(1)}
          onDoubleClick={leftPanel.toggleCollapse}
          title="Drag to resize, double-click to collapse"
          className={resizeHandle}
        />
      )}

      {hasProject && (
        <div className={`${panel} flex-1 min-w-[160px] flex flex-col overflow-hidden`}>
          <div className="flex items-stretch justify-between border-b border-[var(--bark-700)] bg-[var(--bark-900)] shrink-0 min-h-[36px]">
            <div className="flex items-center min-w-0 flex-1 overflow-x-auto">
              {leftPanel.isCollapsed && (
                <button
                  type="button"
                  onClick={leftPanel.toggleCollapse}
                  title="Expand Explorer"
                  aria-label="Expand left panel"
                  className="px-2.5 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-[var(--bark-800)] border-r border-[var(--bark-700)] flex items-center gap-1.5 text-xs shrink-0 cursor-pointer"
                >
                  <PanelLeftOpen size={14} />
                  <span className="text-[11px] font-medium hidden sm:inline">Explorer</span>
                </button>
              )}
              <TabBar files={openFiles} activePath={activePath} onSelect={setActivePath} onClose={closeFile} />
            </div>
            {rightPanel.isCollapsed && (
              <button
                type="button"
                onClick={rightPanel.toggleCollapse}
                title="Expand Conversation"
                aria-label="Expand right panel"
                className="px-2.5 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-[var(--bark-800)] border-l border-[var(--bark-700)] flex items-center gap-1.5 text-xs shrink-0 cursor-pointer self-stretch"
              >
                <span className="text-[11px] font-medium hidden sm:inline">Conversation</span>
                <PanelRightOpen size={14} />
              </button>
            )}
          </div>
          {!active && (
            <div className="flex-1 flex items-center justify-center text-[13px] text-slate-500">
              Pick a file on the left to open it.
            </div>
          )}
          {active && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--bark-700)] shrink-0">
                <span className="text-[11px] text-slate-500 truncate">{active.path}</span>
                <button
                  type="button"
                  onClick={() => void saveFile(active.path)}
                  disabled={!isDirty(active) || savingPath === active.path}
                  className="text-[12px] px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 text-white cursor-pointer disabled:cursor-not-allowed"
                >
                  {savingPath === active.path ? 'Saving…' : 'Save'}
                </button>
              </div>
              {conflictPath === active.path && (
                <div className="flex items-center gap-2 px-3 py-2 bg-amber-950/40 border-b border-amber-800/40 text-[12px] text-amber-300 shrink-0">
                  <AlertTriangle size={13} className="shrink-0" />
                  <span className="flex-1">Someone else changed this file since it was opened.</span>
                  <button type="button" onClick={() => void loadFile(active.path)} className="text-amber-200 hover:text-white underline cursor-pointer">
                    Reload latest
                  </button>
                </div>
              )}
              {loadingPath === active.path ? (
                <div className="flex-1 flex items-center justify-center text-[13px] text-slate-500">Loading…</div>
              ) : (
                <div className="flex-1 min-h-0"><EditorPane file={active} onChange={changeContent} /></div>
              )}
            </div>
          )}
        </div>
      )}

      {hasProject && !rightPanel.isCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversation panel"
          onMouseDown={rightPanel.startResize(-1)}
          onDoubleClick={rightPanel.toggleCollapse}
          title="Drag to resize, double-click to collapse"
          className={resizeHandle}
        />
      )}

      {hasProject && rightPanel.isCollapsed ? (
        <div
          className="shrink-0 flex flex-col items-center py-2 px-1 bg-[var(--bark-800)] border border-[var(--bark-700)] rounded-xl select-none"
          data-testid="right-panel-collapsed"
        >
          <button
            type="button"
            onClick={rightPanel.toggleCollapse}
            title="Expand right panel (Conversation & Branches)"
            aria-label="Expand right panel"
            className="p-1.5 rounded-lg hover:bg-[var(--bark-700)] text-slate-400 hover:text-slate-100 transition-colors cursor-pointer"
          >
            <PanelRightOpen size={16} />
          </button>
          <span
            className="mt-4 text-[10px] font-semibold text-slate-500 uppercase tracking-widest cursor-pointer hover:text-slate-300"
            style={{ writingMode: 'vertical-rl' }}
            onClick={rightPanel.toggleCollapse}
          >
            Conversation
          </span>
        </div>
      ) : (
        <div
          className={`${panel} ${hasProject ? '' : 'flex-1'} shrink-0 flex flex-col overflow-hidden`}
          style={hasProject ? { width: rightPanel.width } : undefined}
        >
          {hasProject && (
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--bark-700)] shrink-0 bg-[var(--bark-900)]/40">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 truncate">
                <MessageSquare size={13} className="text-emerald-400 shrink-0" />
                <span className="truncate">
                  {selectedLeaf ? 'Leaf Detail' : selectedBranch ? (selectedBranch.title || 'Branch Chat') : 'Conversation'}
                </span>
              </div>
              <button
                type="button"
                onClick={rightPanel.toggleCollapse}
                title="Collapse right panel"
                aria-label="Collapse right panel"
                className="p-1 rounded hover:bg-[var(--bark-700)] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer shrink-0"
              >
                <PanelRightClose size={14} />
              </button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3 min-h-0">
          {!hasTree && treeBranches.length === 0 && selected.kind !== 'branch' ? (
            <div className="h-full flex flex-col items-center justify-center text-center gap-3 text-slate-400">
              <MessageSquarePlus size={28} className="text-slate-600" />
              <p className="text-[13px]">No Koala conversation for this project yet.</p>
              <button
                onClick={() => createBranch.mutate()}
                disabled={createBranch.isPending}
                className="text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white cursor-pointer disabled:opacity-50"
              >
                Start a conversation
              </button>
            </div>
          ) : selectedLeaf ? (
            <LeafDetail
              leaf={selectedLeaf}
              subLeaves={childrenOf(selectedLeaf.id)}
              all={leaves}
              onReview={(branchId) => selectBranch(branchId)}
            />
          ) : selectedBranch ? (
            <>
              {!hasTree && (
                <div className="flex items-center justify-between px-3 py-2 mb-2 rounded-lg bg-[var(--bark-800)]/60 border border-[var(--bark-700)] text-[12px] text-slate-400">
                  <span>Just talking — nothing is tracked yet.</span>
                  <button
                    onClick={() => setPromotingBranchId(selectedBranch.id)}
                    className="text-[var(--leaf)] hover:underline cursor-pointer"
                  >
                    Track as a typed tree →
                  </button>
                </div>
              )}
              <BranchChat
                branchId={selectedBranch.id}
                record={selectedBranch}
                leaves={leaves}
                messages={transcripts[selectedBranch.id] ?? selectedBranch.messages ?? []}
                onMessagesChange={(next) =>
                  setTranscripts((t) => ({
                    ...t,
                    [selectedBranch.id]: typeof next === 'function' ? next(t[selectedBranch.id] ?? selectedBranch.messages ?? []) : next,
                  }))
                }
                mode={modes[selectedBranch.id] ?? 'auto'}
                onModeChange={(m) => setModes((all) => ({ ...all, [selectedBranch.id]: m }))}
                onProposals={refresh}
                {...(hasProject ? { projectId: projectId_, attachments, onRemoveAttachment: removeAttachment } : {})}
                onAccept={(id) => accept.mutate(id)}
                onSetAcceptance={async (commands) => {
                  await patchBranch(selectedBranch.id, { acceptance: commands })
                  setAcceptError(null)
                  refresh()
                }}
                onReject={(id) => reject.mutate(id)}
                onAcceptAll={(ids) => acceptAll.mutate(ids)}
                {...(handoff && handoff.branchId === selectedBranch.id
                  ? { autoSend: handoff.prompt, ...(onHandoffTaken ? { onAutoSent: onHandoffTaken } : {}) }
                  : opening && opening.branchId === selectedBranch.id
                    ? { autoSend: opening.prompt, onAutoSent: () => setOpening(undefined) }
                    : {})}
              />
            </>
          ) : (
            <Home
              leaves={leaves}
              branches={treeBranches}
              trees={trees}
              {...(tree ? { tree } : {})}
              lastSeen={seenAt.current}
              onOpenBranch={(id) => selectBranch(id)}
              packNames={Object.fromEntries(packs.map((p) => [p.id, p.name]))}
              starting={startWork.isPending}
              onStart={(_treeId, prompt) => startWork.mutate({ prompt })}
              onOpenLeaf={(leaf) => setSelected({ kind: 'leaf', id: leaf.id })}
              onOpenTree={() => undefined}
            />
          )}
        </div>

        {hasTree && (
          <CollapsibleSection
            title="Branches"
            isOpen={branchesOpen}
            onToggle={setBranchesOpen}
          >
            <BranchesPanel
              branches={treeBranches}
              leaves={leaves}
              selected={selected}
              onSelectBranch={selectBranch}
              onSelectLeaf={(id) => setSelected({ kind: 'leaf', id })}
              onCreateBranch={() => createBranch.mutate()}
              onDeleteBranch={(id) => deleteBranch.mutate(id)}
              creating={createBranch.isPending}
            />
          </CollapsibleSection>
        )}
      </div>
      )}

      {(showNewTree || promotingBranchId) && (
        <NewTreeDialog
          {...(promotingBranchId ? { promoteFromBranchId: promotingBranchId, promoteToProjectId: project?.id } : {})}
          onClose={() => { setShowNewTree(false); setPromotingBranchId(null) }}
          onCreated={(id) => {
            if (!id) return
            if (promotingBranchId) onTreeReady?.(id)
            else linkTree.mutate(id)
            setPromotingBranchId(null)
          }}
        />
      )}
    </div>
  )
}

export default Workspace
