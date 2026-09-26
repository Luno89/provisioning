import { useState } from 'react'
import { ChevronRight, ChevronDown, GitBranch, Trash2 } from 'lucide-react'
import { STATE_DOT, STATE_LABEL, CANCELLED_DOT, stateFor, type Leaf } from '../../leaf-types.js'
import type { Branch } from '../../../types/grove.js'
import type { SelectedEntity } from './shared.js'
import ConfirmDelete from '../../ConfirmDelete.js'

export function BranchesPanel({
  branches, leaves, selected, onSelectLeaf, onDeleteBranch,
}: {
  branches: Branch[]
  leaves: Leaf[]
  selected: SelectedEntity
  onSelectLeaf: (id: string) => void
  onDeleteBranch: (id: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [confirming, setConfirming] = useState<string | null>(null)

  const leavesOf = (branchId: string) => leaves.filter((l) => l.branchId === branchId)

  const renderLeaf = (leaf: Leaf) => {
    const isSelected = selected.kind === 'leaf' && selected.id === leaf.id
    const state = stateFor(leaf, leaves)
    return (
      <div
        key={leaf.id}
        onClick={() => onSelectLeaf(leaf.id)}
        className={`flex items-center gap-1.5 py-1 pr-2 pl-8 rounded-md cursor-pointer text-[12px] ${isSelected ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-800)]'}`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${state ? STATE_DOT[state] : CANCELLED_DOT}`}
          title={state ? STATE_LABEL[state] : 'Cancelled'}
        />
        <span className="truncate">{leaf.title}</span>
      </div>
    )
  }

  return (
    <div className="overflow-y-auto p-2">
      {branches.map((branch) => {
        const own = leavesOf(branch.id)
        const bCollapsed = collapsed[branch.id] ?? false
        return (
          <div key={branch.id}>
            <div
              onClick={() => setCollapsed((c) => ({ ...c, [branch.id]: !bCollapsed }))}
              className="group flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer text-[12px] text-slate-300 hover:bg-[var(--bark-800)]"
            >
              <span className="text-slate-600 shrink-0">
                {bCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </span>
              <GitBranch size={12} className="text-slate-500 shrink-0" />
              <span className="truncate flex-1 min-w-0">{branch.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirming(branch.id)
                }}
                title="Delete branch"
                className="text-slate-500 hover:text-red-400 p-0.5 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0"
              >
                <Trash2 size={12} />
              </button>
            </div>
            {confirming === branch.id && (
              <ConfirmDelete
                prompt={`Delete "${branch.title}" with its leaves, their tasks and plans? A run in progress is stopped.`}
                confirmLabel="Delete branch"
                onConfirm={() => { setConfirming(null); onDeleteBranch(branch.id) }}
                onCancel={() => setConfirming(null)}
              />
            )}
            {!bCollapsed && own.map(renderLeaf)}
          </div>
        )
      })}

      {branches.length === 0 && (
        <p className="text-[11px] text-slate-500 italic px-2 py-1">No branches yet.</p>
      )}
    </div>
  )
}

export default BranchesPanel
