import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { removalText, useMyRemovalProgress } from '../shared'
import { RemovalLines } from './RemovalLines'

export function MyRemovalProgress({ progress }: { progress: string }) {
  const removal = useMyRemovalProgress(progress)
  if (removal.isError) return <div role="alert" className="text-sm text-red-300">{errorMessage(removal.error)}</div>
  if (!removal.data) return <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading how the removal is going…</div>
  if ('removed' in removal.data) return <p className="text-sm text-slate-300">Your account is removed.</p>
  return (
    <div data-testid="my-removal-progress">
      <div className="text-sm text-slate-300">{removalText(removal.data.removal.state, removal.data.removal.steps)}</div>
      <RemovalLines removal={removal.data.removal} />
    </div>
  )
}
