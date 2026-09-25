import { useState, useMemo, useEffect, useRef, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown, ChevronRight, AlertTriangle, MessageSquarePlus,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Folder, MessageSquare,
} from 'lucide-react'
import BranchHistory, { type BranchRecord } from '../../BranchHistory.js'
import ChatSurface from '../../ChatSurface.js'
import Home from '../../Home.js'
import LeafDetail from '../../LeafDetail.js'
import { type Leaf } from '../../leaf-types.js'
import {
  listTrees, listBranches, listLeaves, groveKeys,
  deleteBranch as apiDeleteBranch,
} from '../../../api/grove.js'
import { listPacks } from '../../../api/packs.js'
import { chatPackKeys, createChatConversation, type ConversationBinding } from '../../../api/chat-pack.js'
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
import { TreeSandboxPanel } from './TreeSandboxPanel.js'
import { TreeRunPanel } from './TreeRunPanel.js'
import { TreeProposalsPanel } from './TreeProposalsPanel.js'
import { TreeConversationsPanel } from './TreeConversationsPanel.js'
import { panel, resizeHandle, type SelectedEntity } from './shared.js'
import { useResizableWidth } from './useResizableWidth.js'

interface WorkspaceTree {
  id: string
  name: string
  goal?: string
  projectIds?: string[]
  frozen?: boolean
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
  treeId, projectId, initialBranchId, initialLeafId, onTreeReady,
}: {
  treeId?: string | undefined
  projectId?: string | undefined
  initialBranchId?: string | undefined
  initialLeafId?: string | undefined
  onTreeReady?: ((treeId: string) => void) | undefined
}) {
  const qc = useQueryClient()

  const [selected, setSelected] = useState<SelectedEntity>(() => {
    if (initialLeafId) return { kind: 'leaf', id: initialLeafId }
    if (initialBranchId) return { kind: 'branch', id: initialBranchId }
    return { kind: 'tree', id: treeId ?? '' }
  })
  const [branchesOpen, setBranchesOpen] = useState(() => selected.kind !== 'branch')
  const selectBranch = (id: string) => {
    setSelected({ kind: 'branch', id })
    setBranchesOpen(false)
  }
  useEffect(() => {
    if (initialLeafId) {
      setSelected({ kind: 'leaf', id: initialLeafId })
    } else if (initialBranchId) {
      selectBranch(initialBranchId)
    }
  }, [initialBranchId, initialLeafId])
  const [openingChat, setOpeningChat] = useState<{ conversationId: string; prompt: string } | undefined>()
  const [conversationsOpen, setConversationsOpen] = useState(true)
  const [sandboxOpen, setSandboxOpen] = useState(false)
  const [runOpen, setRunOpen] = useState(true)
  const [proposalsOpen, setProposalsOpen] = useState(true)

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

  const binding: ConversationBinding | undefined = treeId ? { treeId } : project ? { projectId: project.id } : undefined
  const openChat = useMutation({
    mutationFn: ({ prompt }: { prompt?: string }) => createChatConversation(prompt ?? 'New conversation', binding),
    onSuccess: (conversation, { prompt }) => {
      setSelected({ kind: 'conversation', id: conversation.id })
      if (prompt) setOpeningChat({ conversationId: conversation.id, prompt })
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() })
    },
  })
  const deleteBranch = useMutation({
    mutationFn: (id: string) => apiDeleteBranch(id),
    onSuccess: (_, id) => {
      if (selected.kind === 'branch' && selected.id === id) setSelected({ kind: 'tree', id: treeId ?? '' })
      refresh()
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
              <FileTree projectId={projectId_} activePath={activePath} onOpen={(path) => void openFile(path)} />
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
                  {selectedLeaf ? 'Leaf Detail' : selectedBranch ? (selectedBranch.title || 'History') : 'Conversation'}
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
          {!hasTree && selected.kind === 'tree' ? (
            <div className="h-full flex flex-col items-center justify-center text-center gap-3 text-slate-400">
              <MessageSquarePlus size={28} className="text-slate-600" />
              <p className="text-[13px]">Talk to Koala about this project. A plan it proposes becomes this project's tree once you approve it.</p>
              <button
                onClick={() => openChat.mutate({})}
                disabled={openChat.isPending || !binding}
                className="text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white cursor-pointer disabled:opacity-50"
              >
                Start a conversation
              </button>
            </div>
          ) : selected.kind === 'conversation' && binding ? (
            <ChatSurface
              key={selected.id}
              conversationId={selected.id}
              binding={binding}
              hideSidebar
              onOpenTree={(id) => { if (id !== treeId) onTreeReady?.(id) }}
              onConversationChange={(id) => { if (id) setSelected({ kind: 'conversation', id }) }}
              {...(openingChat?.conversationId === selected.id
                ? { autoSend: { text: openingChat.prompt, onSent: () => setOpeningChat(undefined) } }
                : {})}
            />
          ) : selectedLeaf ? (
            <LeafDetail
              leaf={selectedLeaf}
              subLeaves={childrenOf(selectedLeaf.id)}
              all={leaves}
              frozen={Boolean(selectedLeaf.frozen)}
            />
          ) : selectedBranch ? (
            <BranchHistory key={selectedBranch.id} record={selectedBranch} />
          ) : (
            <Home
              leaves={leaves}
              branches={treeBranches}
              trees={trees}
              {...(tree ? { tree } : {})}
              lastSeen={seenAt.current}
              onOpenBranch={(id) => selectBranch(id)}
              packNames={Object.fromEntries(packs.map((p) => [p.id, p.name]))}
              starting={openChat.isPending}
              frozen={Boolean(tree?.frozen)}
              onStart={(_treeId, prompt) => openChat.mutate({ prompt })}
              onOpenLeaf={(leaf) => setSelected({ kind: 'leaf', id: leaf.id })}
              onOpenTree={() => undefined}
            />
          )}
        </div>

        {binding && (
          <CollapsibleSection
            title="Conversations"
            isOpen={conversationsOpen}
            onToggle={setConversationsOpen}
          >
            <TreeConversationsPanel
              binding={binding}
              selected={selected}
              onSelect={(id) => setSelected({ kind: 'conversation', id })}
              {...(tree?.frozen ? {} : { onNew: () => openChat.mutate({}) })}
              creating={openChat.isPending}
            />
          </CollapsibleSection>
        )}
        {(hasTree || treeBranches.length > 0) && (
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
              onDeleteBranch={(id) => deleteBranch.mutate(id)}
            />
          </CollapsibleSection>
        )}
        {hasTree && treeId && !tree?.frozen && (
          <CollapsibleSection
            title="Proposals"
            isOpen={proposalsOpen}
            onToggle={setProposalsOpen}
          >
            <TreeProposalsPanel treeId={treeId} />
          </CollapsibleSection>
        )}
        {hasTree && treeId && !tree?.frozen && (
          <CollapsibleSection
            title="Run"
            isOpen={runOpen}
            onToggle={setRunOpen}
          >
            <TreeRunPanel treeId={treeId} />
          </CollapsibleSection>
        )}
        {hasTree && treeId && (
          <CollapsibleSection
            title="Sandbox"
            isOpen={sandboxOpen}
            onToggle={setSandboxOpen}
          >
            <TreeSandboxPanel treeId={treeId} />
          </CollapsibleSection>
        )}
      </div>
      )}

    </div>
  )
}

export default Workspace
