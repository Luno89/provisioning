import { AlertTriangle, Loader2 } from 'lucide-react'
import { needsYou, running, scopeToTree, treeRollups } from '../../home-summary.js'
import type { Leaf } from '../../leaf-types.js'

export function TreeStrip({ tree, branches, leaves, onOpenLeaf }: {
  tree: { id: string; name: string }
  branches: { id: string; title: string; treeId?: string }[]
  leaves: Leaf[]
  onOpenLeaf: (leaf: Leaf) => void
}) {
  const scoped = scopeToTree(tree.id, branches, leaves)
  const totals = treeRollups([tree], branches, leaves)[0]
  const attention = needsYou(scoped.leaves)
  const live = running(scoped.leaves)
  if (!totals || totals.total === 0) return null
  return (
    <div className="px-3 py-2 border-b border-[var(--bark-700)] space-y-1.5 shrink-0" data-testid="tree-strip">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="text-slate-400">{scoped.branches.length} {scoped.branches.length === 1 ? 'branch' : 'branches'}, {scoped.leaves.length} {scoped.leaves.length === 1 ? 'leaf' : 'leaves'}</span>
        <span className="text-[var(--leaf)] font-mono">{totals.verified} verified</span>
        <span className="text-amber-500 font-mono">{totals.claimed} claimed</span>
        <span className="text-slate-500 font-mono">{totals.outstanding} left</span>
        {live.length > 0 && <span className="flex items-center gap-1 text-sky-300"><Loader2 size={11} className="animate-spin" aria-hidden="true" /> {live.length} working</span>}
        {attention.length > 0 && (
          <button type="button" onClick={() => onOpenLeaf(attention[0]!.leaf)} className="flex items-center gap-1 text-amber-300 hover:underline cursor-pointer">
            <AlertTriangle size={11} aria-hidden="true" /> {attention.length} need{attention.length === 1 ? 's' : ''} you
          </button>
        )}
      </div>
      <div className="flex h-1 rounded-full overflow-hidden bg-[var(--bark-700)]" role="img" aria-label={`${totals.verified} of ${totals.total} verified`}>
        <div className="bg-[var(--leaf)]" style={{ width: `${(totals.verified / totals.total) * 100}%` }} />
        <div className="bg-amber-500/70" style={{ width: `${(totals.claimed / totals.total) * 100}%` }} />
      </div>
    </div>
  )
}

export default TreeStrip
