import { X, Circle } from 'lucide-react'
import { isDirty, type OpenFile } from './shared.js'

export function TabBar({ files, activePath, onSelect, onClose }: {
  files: OpenFile[]
  activePath: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
}) {
  if (files.length === 0) return null

  return (
    <div className="flex items-stretch overflow-x-auto border-b border-[var(--bark-700)] bg-[var(--bark-900)] shrink-0">
      {files.map((f) => (
        <div
          key={f.path}
          className={`group flex items-center gap-2 px-3 py-1.5 text-[12px] border-r border-[var(--bark-700)] cursor-pointer shrink-0 ${
            f.path === activePath ? 'bg-[var(--bark-800)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-800)]/50'
          }`}
          onClick={() => onSelect(f.path)}
        >
          <span className="truncate max-w-[160px]" title={f.path}>{f.path.split('/').pop()}</span>
          {isDirty(f) ? (
            <Circle size={7} className="fill-current text-amber-400 shrink-0" />
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClose(f.path); }}
              className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-200 shrink-0"
            >
              <X size={12} />
            </button>
          )}
          {isDirty(f) && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClose(f.path); }}
              className="text-slate-500 hover:text-slate-200 shrink-0"
              title="Unsaved changes — closing discards them"
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export default TabBar
