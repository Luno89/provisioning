import { useState, useEffect, useRef, lazy, Suspense, Component, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import NewTreeDialog from '../NewTreeDialog.js'
import { NewProjectDialog } from './NewProjectDialog.js'
import { ProjectList } from './ProjectList.js'
import { listBranches } from '../../api/grove.js'
import { parseHash, formatHash } from '../../lib/route.js'

const Workspace = lazy(() => import('./Workspace/index.js'))

class WorkspaceErrorBoundary extends Component<{ onBack: () => void; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="max-w-xl mx-auto mt-10 bg-[var(--bark-800)] border border-red-900/50 rounded-xl p-5 text-slate-200">
          <p className="text-sm font-semibold text-red-400 mb-2">The workspace hit a problem</p>
          <p className="text-xs text-slate-400 mb-4 font-mono break-words">{this.state.error.message}</p>
          <button
            type="button"
            onClick={this.props.onBack}
            className="text-xs px-3 py-1.5 rounded-lg bg-[var(--bark-700)] hover:bg-[var(--bark-600)] text-slate-200"
          >
            Back to Projects
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export type Open = { kind: 'tree'; id: string; branchId?: string; leafId?: string } | { kind: 'project'; id: string }

export function parseOpenFromHash(): Open | null {
  if (typeof window === 'undefined') return null
  const route = parseHash(window.location.hash)
  if (route?.view !== 'projects') return null
  if (route.path[0] === 'tree' && route.path[1]) {
    return {
      kind: 'tree', id: route.path[1],
      ...(route.path[2] ? { branchId: route.path[2] } : {}),
      ...(route.path[3] ? { leafId: route.path[3] } : {}),
    }
  }
  if (route.path[0] === 'project' && route.path[1]) return { kind: 'project', id: route.path[1] }
  return null
}

interface Cluster {
  id: string
  name: string
}

function useSafeProjectsRoute() {
  const router = useRouter({ warn: false });

  const getParams = (pathname = router?.state?.location?.pathname) => {
    if (!pathname) return null;
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 'projects') return null;
    if (parts[1] === 'tree' && parts[2]) {
      return {
        treeId: parts[2],
        branchId: parts[3],
        leafId: parts[4],
      };
    }
    if (parts[1] === 'project' && parts[2]) {
      return {
        projectId: parts[2],
      };
    }
    return null;
  };

  const [params, setParams] = useState(() => getParams());

  useEffect(() => {
    if (!router?.subscribe) return;
    return router.subscribe('onResolved', (evt: any) => {
      setParams(getParams(evt?.toLocation?.pathname));
    });
  }, [router]);

  return {
    params,
    navigate: router ? (opts: any) => router.navigate(opts) : null,
  };
}

export function Projects({ clusters, handoff, onHandoffTaken }: {
  clusters: Cluster[]
  handoff?: { branchId: string; prompt: string } | undefined
  onHandoffTaken?: (() => void) | undefined
}) {
  const { params: routerParams, navigate } = useSafeProjectsRoute()

  const getActiveOpen = (): Open | null => {
    if (routerParams?.treeId) {
      return {
        kind: 'tree',
        id: routerParams.treeId,
        ...(routerParams.branchId ? { branchId: routerParams.branchId } : {}),
        ...(routerParams.leafId ? { leafId: routerParams.leafId } : {}),
      }
    }
    if (routerParams?.projectId) {
      return {
        kind: 'project',
        id: routerParams.projectId,
      }
    }
    return parseOpenFromHash()
  }

  const [open, setOpen] = useState<Open | null>(() => getActiveOpen())
  const [showNewTree, setShowNewTree] = useState(false)
  const [showNewProject, setShowNewProject] = useState(false)

  useEffect(() => {
    const next = getActiveOpen()
    setOpen(next)
  }, [routerParams?.treeId, routerParams?.branchId, routerParams?.leafId, routerParams?.projectId])

  useEffect(() => {
    const onHashChange = () => {
      setOpen(parseOpenFromHash())
    }
    window.addEventListener('hashchange', onHashChange)
    window.addEventListener('popstate', onHashChange)
    return () => {
      window.removeEventListener('hashchange', onHashChange)
      window.removeEventListener('popstate', onHashChange)
    }
  }, [])

  const { data: branches = [] } = useQuery({
    queryKey: ['branches'],
    queryFn: listBranches,
    enabled: Boolean(handoff),
  })

  const openedHandoffRef = useRef<string | null>(null)
  useEffect(() => {
    if (!handoff || openedHandoffRef.current === handoff.branchId) return
    const record = branches.find((b: { id: string; treeId?: string }) => b.id === handoff.branchId)
    if (!record?.treeId) return
    openedHandoffRef.current = handoff.branchId
    const nextOpen: Open = { kind: 'tree', id: record.treeId, branchId: handoff.branchId }
    setOpen(nextOpen)
    if (navigate) {
      navigate({
        to: '/projects/tree/$treeId/$branchId',
        params: { treeId: record.treeId, branchId: handoff.branchId },
      }).catch(() => {})
    } else {
      window.location.hash = formatHash('projects', ['tree', record.treeId, handoff.branchId])
    }
  }, [handoff, branches, navigate])

  const openEntity = (next: Open) => {
    const path = next.kind === 'tree' ? ['tree', next.id] : ['project', next.id]
    window.location.hash = formatHash('projects', path)
    if (navigate) {
      if (next.kind === 'tree') {
        navigate({ to: '/projects/tree/$treeId', params: { treeId: next.id } }).catch(() => {})
      } else {
        navigate({ to: '/projects/project/$projectId', params: { projectId: next.id } }).catch(() => {})
      }
    }
    setOpen(next)
  }

  const closeEntity = () => {
    window.location.hash = formatHash('projects')
    if (navigate) {
      navigate({ to: '/projects' }).catch(() => {})
    }
    setOpen(null)
  }

  if (open) {
    return (
      <div className="h-full min-h-0 flex flex-col p-3">
        <button
          onClick={closeEntity}
          className="shrink-0 flex items-center gap-1 text-[12px] text-slate-400 hover:text-slate-200 mb-3 cursor-pointer"
        >
          <ChevronLeft size={14} /> Back to Projects
        </button>
        <WorkspaceErrorBoundary onBack={closeEntity}>
          <Suspense fallback={<div className="text-slate-400 text-sm py-10 text-center">Loading workspace…</div>}>
            <Workspace
              key={open.kind === 'tree' ? `tree-${open.id}` : `project-${open.id}`}
              {...(open.kind === 'tree' ? { treeId: open.id } : { projectId: open.id })}
              {...(open.kind === 'tree' && open.branchId ? { initialBranchId: open.branchId } : {})}
              {...(open.kind === 'tree' && open.leafId ? { initialLeafId: open.leafId } : {})}
              {...(handoff && open.kind === 'tree' && open.branchId === handoff.branchId
                ? { handoff, ...(onHandoffTaken ? { onHandoffTaken } : {}) }
                : {})}
              onTreeReady={(treeId) => openEntity({ kind: 'tree', id: treeId })}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <ProjectList
        onOpenTree={(id) => openEntity({ kind: 'tree', id })}
        onOpenProject={(id) => openEntity({ kind: 'project', id })}
        onNewTree={() => setShowNewTree(true)}
        onNewProject={() => setShowNewProject(true)}
      />

      {showNewTree && (
        <NewTreeDialog
          onClose={() => setShowNewTree(false)}
          onCreated={(id) => { setShowNewTree(false); if (id) openEntity({ kind: 'tree', id }) }}
        />
      )}

      {showNewProject && (
        <NewProjectDialog
          clusters={clusters}
          onClose={() => setShowNewProject(false)}
          onCreated={(id) => { setShowNewProject(false); openEntity({ kind: 'project', id }) }}
        />
      )}
    </div>
  )
}

export default Projects
