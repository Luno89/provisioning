import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { groveKeys } from '../../api/grove'
import { errorMessage } from '../../../../api/client'
import { withOrder } from './board'
import { keyedBy, useWorkSource } from '../../lib/work-source'

function useOrdering<Vars extends { order: readonly string[] }>(key: QueryKey, save: (vars: Vars) => Promise<void>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: save,
    onMutate: async (vars: Vars) => {
      await qc.cancelQueries({ queryKey: key })
      const before = qc.getQueryData<{ id: string; priority?: number | undefined }[]>(key)
      if (before) qc.setQueryData(key, withOrder(before, vars.order))
      return { before }
    },
    onError: (_err, _vars, context) => { if (context?.before) qc.setQueryData(key, context.before) },
    onSettled: () => { void qc.invalidateQueries({ queryKey: key }) },
  })
}

export function useBoardOrder() {
  const source = useWorkSource()
  const stories = useOrdering<{ branchId: string; order: readonly string[] }>(keyedBy(source, groveKeys.leaves()), ({ branchId, order }) => source.orderStories(branchId, order))
  const features = useOrdering<{ treeId: string; order: readonly string[] }>(keyedBy(source, groveKeys.branches()), ({ treeId, order }) => source.orderFeatures(treeId, order))
  const failed = stories.error ?? features.error
  return {
    can: source.can('change-work'),
    orderStories: (branchId: string, order: readonly string[]) => stories.mutate({ branchId, order }),
    orderFeatures: (treeId: string, order: readonly string[]) => features.mutate({ treeId, order }),
    error: failed ? errorMessage(failed) || 'The new order was not saved.' : undefined,
  }
}
