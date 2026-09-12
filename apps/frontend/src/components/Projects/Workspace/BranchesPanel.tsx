import { useState } from 'react'
import { ChevronRight, ChevronDown, GitBranch, Plus, Trash2 } from 'lucide-react'
import { STATE_DOT, STATE_LABEL, CANCELLED_DOT, stateFor, type Leaf } from '../../leaf-types.js'
import type { BranchRecord } from '../../BranchChat.js'
import type { SelectedEntity } from './shared.js'

export function BranchesPanel({
  branches, leaves, selected, onSelectBranch, onSelectLeaf, onCreateBranch, onDeleteBranch, creating,
}: {
  branches: BranchRecord[]
  leaves: Leaf[]
  selected: SelectedEntity
  onSelectBranch: (id: string) => void
  onSelectLeaf: (id: string) => void
  onCreateBranch: () => void
  onDeleteBranch: (id: string) => void
  creating?: boolean
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const leavesOf = (branchId: string) => leaves.filter((l) => l.branchId === branchId && !l.parentLeafId)
  const childrenOf = (leafId: string) => leaves.filter((l) => l.parentLeafId === leafId)

  const renderLeaf = (leaf: Leaf, depth: number) => {
    const kids = childrenOf(leaf.id)
    const isCollapsed = collapsed[leaf.id] ?? false
    const isSelected = selected.kind === 'leaf' && selected.id === leaf.id
    const state = stateFor(leaf, leaves)
    return (
      <div key={leaf.id}>
        <div
          onClick={() => onSelectLeaf(leaf.id)}
          className={`flex items-center gap-1.5 py-1 pr-2 rounded-md cursor-pointer text-[12px] ${isSelected ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-800)]'}`}
          style={{ paddingLeft: `${depth * 12 + 20}px` }}
        >
          {kids.length > 0 ? (
            <button
              onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [leaf.id]: !isCollapsed })) }}
              className="text-slate-600 hover:text-slate-300 shrink-0"
            >
              {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            </button>
          ) : <span className="w-3 shrink-0" />}
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${state ? STATE_DOT[state] : CANCELLED_DOT}`}
            title={state ? STATE_LABEL[state] : 'Cancelled'}
          />
          <span className="truncate">{leaf.title}</span>
          {kids.length > 0 && <span className="text-[10px] text-slate-600 shrink-0">{kids.length}</span>}
        </div>
        {!isCollapsed && kids.map((k) => renderLeaf(k, depth + 1))}
      </div>
    )
  }

  return (
    <div className="overflow-y-auto p-2">
      {branches.map((branch) => {
        const roots = leavesOf(branch.id)
        const bCollapsed = collapsed[branch.id] ?? false
        const bSelected = selected.kind === 'branch' && selected.id === branch.id
        return (
          <div key={branch.id}>
            <div
              onClick={() => onSelectBranch(branch.id)}
              className={`group flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer text-[12px] ${bSelected ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-300 hover:bg-[var(--bark-800)]'}`}
            >
              <button
                onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [branch.id]: !bCollapsed })) }}
                className="text-slate-600 hover:text-slate-300 shrink-0"
              >
                {bCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </button>
              <GitBranch size={12} className="text-slate-500 shrink-0" />
              <span className="truncate flex-1 min-w-0">{branch.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`Delete branch "${branch.title}" and all its leaves?`)) onDeleteBranch(branch.id)
                }}
                title="Delete branch"
                className="text-slate-500 hover:text-red-400 p-0.5 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0"
              >
                <Trash2 size={12} />
              </button>
            </div>
            {!bCollapsed && roots.map((l) => renderLeaf(l, 1))}
          </div>
        )
      })}

      {branches.length === 0 && (
        <p className="text-[11px] text-slate-500 italic px-2 py-1">No conversations yet.</p>
      )}

      <button
        onClick={onCreateBranch}
        disabled={creating}
        className="flex items-center gap-1.5 px-2 py-1 text-[12px] text-slate-600 hover:text-[var(--leaf)] disabled:opacity-50"
      >
        <Plus size={12} /> new conversation
      </button>
    </div>
  )
}

export default BranchesPanel
