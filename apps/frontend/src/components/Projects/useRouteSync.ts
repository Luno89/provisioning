import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { formatHash, parseHash, shouldReplace } from '../../lib/route'

export type ProjectPlace =
  | { kind: 'tree'; treeId: string; files?: boolean | undefined; branchId?: string | undefined; leafId?: string | undefined }
  | { kind: 'project'; projectId: string; files?: boolean | undefined }

export function placePath(place: ProjectPlace): string[] {
  if (place.kind === 'project') return ['project', place.projectId, ...(place.files ? ['files'] : [])]
  if (place.files) return ['tree', place.treeId, 'files']
  return ['tree', place.treeId, ...(place.branchId ? [place.branchId, ...(place.leafId ? [place.leafId] : [])] : [])]
}

export function useRouteSync(place: ProjectPlace | undefined) {
  const router = useRouter({ warn: false })
  const kind = place?.kind
  const id = place ? (place.kind === 'project' ? place.projectId : place.treeId) : undefined
  const files = Boolean(place?.files)
  const branchId = place?.kind === 'tree' ? place.branchId : undefined
  const leafId = place?.kind === 'tree' ? place.leafId : undefined

  useEffect(() => {
    if (!kind || !id) return
    const at: ProjectPlace = kind === 'project' ? { kind, projectId: id, files } : { kind: 'tree', treeId: id, files, branchId, leafId }
    const path = placePath(at)
    const hash = formatHash('projects', path)
    if (window.location.hash === hash) return
    const from = parseHash(window.location.hash)
    const sameEntity = from?.view === 'projects' && from.path[0] === path[0] && from.path[1] === path[1]
    const itemMoved = sameEntity && !files && from.path[2] !== 'files' && from.path.slice(2).join('/') !== path.slice(2).join('/')
    const replace = shouldReplace(from, { view: 'projects', path }) && !itemMoved
    if (replace) window.history.replaceState(null, '', hash)
    else window.history.pushState(null, '', hash)
    if (!router) return
    const go = kind === 'project'
      ? files
        ? router.navigate({ to: '/projects/project/$projectId/files', params: { projectId: id }, replace })
        : router.navigate({ to: '/projects/project/$projectId', params: { projectId: id }, replace })
      : files
        ? router.navigate({ to: '/projects/tree/$treeId/files', params: { treeId: id }, replace })
        : branchId && leafId
          ? router.navigate({ to: '/projects/tree/$treeId/$branchId/$leafId', params: { treeId: id, branchId, leafId }, replace })
          : branchId
            ? router.navigate({ to: '/projects/tree/$treeId/$branchId', params: { treeId: id, branchId }, replace })
            : router.navigate({ to: '/projects/tree/$treeId', params: { treeId: id }, replace })
    go.catch(() => {})
  }, [kind, id, files, branchId, leafId, router])
}
