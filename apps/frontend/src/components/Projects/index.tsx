import { useState, useEffect, lazy, Suspense, Component, type ReactNode } from 'react'
import { useRouter, type NavigateOptions } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import NewTreeDialog from '../NewTreeDialog.js'
import { NewProjectDialog } from './NewProjectDialog.js'
import { ProjectList } from './ProjectList.js'
import { parseHash, formatHash } from '../../lib/route.js'
import { pageOf, type ProjectPage } from './useRouteSync.js'
import { useChatPanel } from './useChatPanel.js'

const ProjectFiles = lazy(() => import('./Files/index.js'))
const ProjectReleases = lazy(() => import('./Releases/index.js'))
const ProjectStrip = lazy(() => import('./Strip/ProjectStrip.js'))
const ProjectBoard = lazy(() => import('./Board/index.js'))
const ProjectSettings = lazy(() => import('./Settings/index.js'))

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

export type Open = { kind: 'tree'; id: string; branchId?: string; leafId?: string; page?: ProjectPage } | { kind: 'project'; id: string; page?: ProjectPage }

function parseOpenFromHash(): Open | null {
  if (typeof window === 'undefined') return null
  const route = parseHash(window.location.hash)
  if (route?.view !== 'projects') return null
  const page = pageOf(route.path[2])
  if (route.path[0] === 'tree' && route.path[1] && page) return { kind: 'tree', id: route.path[1], page }
  if (route.path[0] === 'tree' && route.path[1]) {
    return {
      kind: 'tree', id: route.path[1],
      ...(route.path[2] ? { branchId: route.path[2] } : {}),
      ...(route.path[3] ? { leafId: route.path[3] } : {}),
    }
  }
  if (route.path[0] === 'project' && route.path[1]) return { kind: 'project', id: route.path[1], ...(page ? { page } : {}) }
  return null
}

interface Cluster {
  id: string
  name: string
}

function useSafeProjectsRoute() {
  const router = useRouter({ warn: false });

  type RouteParams = { treeId?: string; branchId?: string | undefined; leafId?: string | undefined; projectId?: string; page?: ProjectPage };
  const getParams = (pathname = router?.state?.location?.pathname): RouteParams | null => {
    if (!pathname) return null;
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 'projects') return null;
    const page = pageOf(parts[3]);
    if (parts[1] === 'tree' && parts[2] && page) return { treeId: parts[2], page };
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
        ...(page ? { page } : {}),
      };
    }
    return null;
  };

  const [params, setParams] = useState(() => getParams());

  useEffect(() => {
    if (!router?.subscribe) return;
    return router.subscribe('onResolved', (evt) => {
      setParams(getParams(evt.toLocation.pathname));
    });
  }, [router]);

  return {
    params,
    navigate: router ? (opts: NavigateOptions) => router.navigate(opts) : null,
  };
}

export function Projects({ clusters }: {
  clusters: Cluster[]
}) {
  const { params: routerParams, navigate } = useSafeProjectsRoute()

  const getActiveOpen = (): Open | null => {
    if (routerParams?.treeId) {
      return {
        kind: 'tree',
        id: routerParams.treeId,
        ...(routerParams.branchId ? { branchId: routerParams.branchId } : {}),
        ...(routerParams.leafId ? { leafId: routerParams.leafId } : {}),
        ...(routerParams.page ? { page: routerParams.page } : {}),
      }
    }
    if (routerParams?.projectId) {
      return {
        kind: 'project',
        id: routerParams.projectId,
        ...(routerParams.page ? { page: routerParams.page } : {}),
      }
    }
    return parseOpenFromHash()
  }

  const [open, setOpen] = useState<Open | null>(() => getActiveOpen())
  const [showNewTree, setShowNewTree] = useState(false)
  const [showNewProject, setShowNewProject] = useState(false)
  const chat = useChatPanel(open ? `${open.kind}:${open.id}` : undefined)

  const routeKey = [routerParams?.treeId, routerParams?.branchId, routerParams?.leafId, routerParams?.projectId, routerParams?.page ?? ''].join('|')
  const [seenRouteKey, setSeenRouteKey] = useState(routeKey)
  if (routeKey !== seenRouteKey) {
    setSeenRouteKey(routeKey)
    setOpen(getActiveOpen())
  }

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

  const openEntity = (next: Open) => {
    window.location.assign(formatHash('projects', [next.kind, next.id, ...(next.page ? [next.page] : [])]))
    if (navigate) {
      const go = next.kind === 'tree'
        ? next.page === 'files'
          ? navigate({ to: '/projects/tree/$treeId/files', params: { treeId: next.id } })
          : next.page === 'releases'
            ? navigate({ to: '/projects/tree/$treeId/releases', params: { treeId: next.id } })
            : next.page === 'settings'
              ? navigate({ to: '/projects/tree/$treeId/settings', params: { treeId: next.id } })
              : navigate({ to: '/projects/tree/$treeId', params: { treeId: next.id } })
        : next.page === 'files'
          ? navigate({ to: '/projects/project/$projectId/files', params: { projectId: next.id } })
          : next.page === 'releases'
            ? navigate({ to: '/projects/project/$projectId/releases', params: { projectId: next.id } })
            : next.page === 'settings'
              ? navigate({ to: '/projects/project/$projectId/settings', params: { projectId: next.id } })
              : navigate({ to: '/projects/project/$projectId', params: { projectId: next.id } })
      go.catch(() => {})
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
    const scope = open.kind === 'tree' ? { treeId: open.id } : { projectId: open.id }
    return (
      <div className="h-full min-h-0 flex flex-col p-3">
        <div className="shrink-0 flex items-center gap-4 mb-3">
          <button
            onClick={closeEntity}
            className="flex items-center gap-1 text-[12px] text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            <ChevronLeft size={14} /> Back to Projects
          </button>
          <div role="tablist" aria-label="Project view" className="flex rounded-md border border-[var(--bark-700)] overflow-hidden text-[12px]">
            {([['board', 'Board'], ['releases', 'Releases'], ['files', 'Files'], ['settings', 'Settings']] as const).map(([id, label]) => {
              const on = id === 'board' ? !open.page : open.page === id
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => { if (!on) openEntity({ kind: open.kind, id: open.id, ...(id === 'board' ? {} : { page: id }) }) }}
                  className={`px-3 py-1 cursor-pointer ${on ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
        <WorkspaceErrorBoundary onBack={closeEntity}>
          <Suspense fallback={<div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}>
            <ProjectStrip key={`strip-${open.kind}-${open.id}`} {...scope} {...(!open.page ? { channel: { open: chat.open, onToggle: chat.toggle } } : {})} />
            {open.page === 'settings' ? (
              <ProjectSettings key={`settings-${open.kind}-${open.id}`} {...scope} onDeleted={closeEntity} />
            ) : open.page === 'releases' ? (
              <ProjectReleases key={`releases-${open.kind}-${open.id}`} {...scope} />
            ) : open.page === 'files' ? (
              <ProjectFiles key={`files-${open.kind}-${open.id}`} {...scope} />
            ) : (
              <ProjectBoard
                key={open.kind === 'tree' ? `board-tree-${open.id}` : `board-project-${open.id}`}
                {...scope}
                chatOpen={chat.open}
                {...(open.kind === 'tree' && open.branchId ? { initialBranchId: open.branchId } : {})}
                {...(open.kind === 'tree' && open.leafId ? { initialLeafId: open.leafId } : {})}
                onTreeReady={(treeId) => openEntity({ kind: 'tree', id: treeId })}
              />
            )}
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
