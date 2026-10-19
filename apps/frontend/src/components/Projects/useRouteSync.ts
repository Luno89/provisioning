import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { formatHash, parseHash, shouldReplace } from '../../lib/route'

export const PROJECT_PAGES = ['releases', 'files', 'settings'] as const
export type ProjectPage = typeof PROJECT_PAGES[number]

export const pageOf = (segment: string | undefined): ProjectPage | undefined =>
  PROJECT_PAGES.find((page) => page === segment)

export type ProjectPlace =
  | { kind: 'tree'; treeId: string; page?: ProjectPage | undefined; branchId?: string | undefined; leafId?: string | undefined }
  | { kind: 'project'; projectId: string; page?: ProjectPage | undefined }

export function placePath(place: ProjectPlace): string[] {
  if (place.kind === 'project') return ['project', place.projectId, ...(place.page ? [place.page] : [])]
  if (place.page) return ['tree', place.treeId, place.page]
  return ['tree', place.treeId, ...(place.branchId ? [place.branchId, ...(place.leafId ? [place.leafId] : [])] : [])]
}

export function useRouteSync(place: ProjectPlace | undefined) {
  const router = useRouter({ warn: false })
  const kind = place?.kind
  const id = place ? (place.kind === 'project' ? place.projectId : place.treeId) : undefined
  const page = place?.page
  const branchId = place?.kind === 'tree' ? place.branchId : undefined
  const leafId = place?.kind === 'tree' ? place.leafId : undefined

  useEffect(() => {
    if (!kind || !id) return
    const at: ProjectPlace = kind === 'project' ? { kind, projectId: id, page } : { kind: 'tree', treeId: id, page, branchId, leafId }
    const path = placePath(at)
    const hash = formatHash('projects', path)
    if (window.location.hash === hash) return
    const from = parseHash(window.location.hash)
    const sameEntity = from?.view === 'projects' && from.path[0] === path[0] && from.path[1] === path[1]
    const itemMoved = sameEntity && !page && !pageOf(from.path[2]) && from.path.slice(2).join('/') !== path.slice(2).join('/')
    const replace = shouldReplace(from, { view: 'projects', path }) && !itemMoved
    if (replace) window.history.replaceState(null, '', hash)
    else window.history.pushState(null, '', hash)
    if (!router) return
    const go = kind === 'project'
      ? page === 'files'
        ? router.navigate({ to: '/projects/project/$projectId/files', params: { projectId: id }, replace })
        : page === 'settings'
          ? router.navigate({ to: '/projects/project/$projectId/settings', params: { projectId: id }, replace })
          : router.navigate({ to: '/projects/project/$projectId', params: { projectId: id }, replace })
      : page === 'files'
        ? router.navigate({ to: '/projects/tree/$treeId/files', params: { treeId: id }, replace })
        : page === 'settings'
          ? router.navigate({ to: '/projects/tree/$treeId/settings', params: { treeId: id }, replace })
          : branchId && leafId
            ? router.navigate({ to: '/projects/tree/$treeId/$branchId/$leafId', params: { treeId: id, branchId, leafId }, replace })
            : branchId
              ? router.navigate({ to: '/projects/tree/$treeId/$branchId', params: { treeId: id, branchId }, replace })
              : router.navigate({ to: '/projects/tree/$treeId', params: { treeId: id }, replace })
    go.catch(() => {})
  }, [kind, id, page, branchId, leafId, router])
}
