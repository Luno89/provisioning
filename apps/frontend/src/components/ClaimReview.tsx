import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Gavel, GitCommit, Loader2 } from 'lucide-react'
import { settleLeaf } from '../api/grove'
import { errorMessage } from '../api/client'
import { isAwaitingReview, type Leaf } from './leaf-types'

export default function ClaimReview({ leaf }: { leaf: Leaf }) {
  const qc = useQueryClient()
  const [failing, setFailing] = useState(false)
  const [note, setNote] = useState('')

  const settle = useMutation({
    mutationFn: ({ verdict, reason }: { verdict: 'verified' | 'failed'; reason?: string }) => settleLeaf(leaf.id, verdict, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leaves'] })
      qc.invalidateQueries({ queryKey: ['tree-board'] })
    },
  })

  if (!leaf.claim) return null
  const parked = isAwaitingReview(leaf)

  return (
    <div className="mt-5 rounded-lg border border-amber-700/50 bg-amber-950/20 p-3 text-[12px] flex flex-col gap-2" data-testid="claim-review">
      <div className="flex items-center gap-2 text-amber-300 font-medium">
        <Gavel size={13} />
        {parked ? 'The judge could not settle this claim — it is waiting for you' : 'Claimed — waiting for the judge'}
      </div>
      {parked && leaf.review?.reason && <div className="text-slate-300"><span className="text-slate-500">Judge: </span>{leaf.review.reason}</div>}
      <div className="text-slate-300 whitespace-pre-wrap"><span className="text-slate-500">Evidence: </span>{leaf.claim.evidence}</div>
      {leaf.claim.findings && <div className="text-slate-400"><span className="text-slate-500">Findings: </span>{leaf.claim.findings}</div>}
      {leaf.claim.commit && (
        <div className="flex items-center gap-1.5 text-slate-400 font-mono"><GitCommit size={12} /> {leaf.claim.commit.slice(0, 12)}</div>
      )}

      {parked && !failing && (
        <div className="flex items-center gap-2 self-end">
          <button type="button" onClick={() => setFailing(true)} disabled={settle.isPending}
            className="px-2.5 py-1 rounded bg-[var(--bark-700)] hover:bg-[var(--bark-600)] cursor-pointer disabled:opacity-50">
            It failed…
          </button>
          <button type="button" onClick={() => settle.mutate({ verdict: 'verified' })} disabled={settle.isPending}
            className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
            {settle.isPending && <Loader2 size={12} className="animate-spin" />} It meets the goal
          </button>
        </div>
      )}
      {parked && failing && (
        <div className="flex items-center gap-2">
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="What does it miss? (the replan reads this)"
            className="flex-1 px-2 py-1 rounded bg-[var(--bark-900)] border border-[var(--bark-700)] text-slate-200" />
          <button type="button" onClick={() => setFailing(false)} className="px-2 py-1 rounded hover:bg-[var(--bark-700)] cursor-pointer">Back</button>
          <button type="button" onClick={() => settle.mutate({ verdict: 'failed', reason: note.trim() })} disabled={settle.isPending || !note.trim()}
            className="px-2.5 py-1 rounded bg-red-700 hover:bg-red-600 text-white cursor-pointer disabled:opacity-50">
            Fail it
          </button>
        </div>
      )}
      {settle.error && <div className="text-red-400">{errorMessage(settle.error) || 'That did not settle.'}</div>}
    </div>
  )
}
