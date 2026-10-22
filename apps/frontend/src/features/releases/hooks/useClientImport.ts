import { useQuery } from '@tanstack/react-query'
import { clientImportKeys, getImport } from '../api/client-import'

const MOVING = new Set(['uploading', 'uploaded', 'importing'])

export function useClientImport(projectId: string | undefined) {
  return useQuery({
    queryKey: clientImportKeys.view(projectId ?? ''),
    queryFn: () => getImport(projectId!),
    enabled: Boolean(projectId),
    refetchInterval: (query) => (MOVING.has(query.state.data?.import?.state ?? '') ? 4000 : false),
  })
}
