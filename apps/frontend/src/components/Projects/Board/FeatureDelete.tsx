import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import ConfirmDelete from '../../ConfirmDelete'
import { deleteBranch, groveKeys } from '../../../api/grove'
import { errorMessage } from '../../../api/client'

export function FeatureDelete({ branchId, title, onDeleted }: { branchId: string; title: string; onDeleted: () => void }) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const remove = useMutation({
    mutationFn: () => deleteBranch(branchId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: groveKeys.branches() })
      void qc.invalidateQueries({ queryKey: groveKeys.leaves() })
      onDeleted()
    },
  })

  return (
    <div className="pt-2 border-t border-[var(--bark-800)] text-[12px]" data-testid="feature-delete">
      {confirming ? (
        <ConfirmDelete
          prompt={`Delete "${title}" with its stories, their tasks and plans? A run in progress is stopped.`}
          confirmLabel="Delete feature"
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className="flex items-center gap-1.5 text-slate-500 hover:text-red-400 cursor-pointer">
          <Trash2 size={12} /> Delete this feature
        </button>
      )}
      {remove.error && <p className="mt-1 text-red-400">{errorMessage(remove.error)}</p>}
    </div>
  )
}
