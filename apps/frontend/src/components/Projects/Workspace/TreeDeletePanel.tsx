import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { deleteTree } from '../../../api/grove.js'
import { chatPackKeys } from '../../../api/chat-pack.js'
import { planKeys } from '../../../api/plans.js'
import { errorMessage } from '../../../api/client.js'

export function TreeDeletePanel({ treeId, treeName, onDeleted }: {
  treeId: string
  treeName: string
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)

  const remove = useMutation({
    mutationFn: () => deleteTree(treeId),
    onSuccess: () => {
      for (const queryKey of [['trees'], ['branches'], ['leaves'], chatPackKeys.conversations(), planKeys.all]) {
        void qc.invalidateQueries({ queryKey })
      }
      onDeleted()
    },
  })

  return (
    <div className="px-3 py-2 text-[12px] text-slate-400 flex flex-col gap-2" data-testid="tree-delete">
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-amber-300">
            Delete “{treeName}” with its branches, leaves, tasks, plans, conversations and sandbox? A run in progress is stopped.
          </span>
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="px-2 py-1 rounded-md bg-red-700 hover:bg-red-600 text-white cursor-pointer disabled:opacity-50"
          >
            {remove.isPending ? 'Deleting…' : 'Delete tree'}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="px-2 py-1 rounded-md hover:bg-[var(--bark-700)] cursor-pointer">
            Keep
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="self-start flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--bark-700)] hover:bg-[var(--bark-700)] cursor-pointer"
        >
          <Trash2 size={12} /> Delete this tree
        </button>
      )}
      {remove.error && <span className="text-red-400">The tree could not be deleted: {errorMessage(remove.error)}</span>}
    </div>
  )
}
