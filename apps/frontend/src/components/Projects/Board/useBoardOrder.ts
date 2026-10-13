import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { groveKeys, orderFeatures, orderStories } from '../../../api/grove'
import { errorMessage } from '../../../api/client'
import { withOrder } from './board'

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
  const stories = useOrdering<{ branchId: string; order: readonly string[] }>(groveKeys.leaves(), ({ branchId, order }) => orderStories(branchId, order))
  const features = useOrdering<{ treeId: string; order: readonly string[] }>(groveKeys.branches(), ({ treeId, order }) => orderFeatures(treeId, order))
  const failed = stories.error ?? features.error
  return {
    orderStories: (branchId: string, order: readonly string[]) => stories.mutate({ branchId, order }),
    orderFeatures: (treeId: string, order: readonly string[]) => features.mutate({ treeId, order }),
    error: failed ? errorMessage(failed) || 'The new order was not saved.' : undefined,
  }
}
