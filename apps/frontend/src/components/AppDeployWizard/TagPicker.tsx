import { useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useImageTags, TAG_SORTS, TAG_SORT_LABELS, EMPTY_TAG_PAGE, type TagSort } from '../../api/models'

interface TagPickerProps {
  repo: string
  selected: string
  onSelect: (tag: string) => void
  enabled: boolean
  label?: string
}

export function TagPicker({ repo, selected, onSelect, enabled, label = 'Available Tags' }: TagPickerProps) {
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<TagSort>('newest')

  const { data = EMPTY_TAG_PAGE, isLoading, isFetching } = useImageTags(repo, enabled, { page, sort })
  const { tags, total, totalPages } = data

  const changeSort = (next: TagSort) => {
    setSort(next)
    setPage(1)
  }

  const selectedOffPage = selected && !tags.includes(selected)

  return (
    <div>
      <div className="flex items-end justify-between gap-4 mb-2">
        <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">
          {label}
          {total > 0 && <span className="ml-2 text-slate-600 normal-case tracking-normal font-normal">{total} found</span>}
        </label>
        <select
          aria-label="Sort tags"
          value={sort}
          onChange={(e) => changeSort(e.target.value as TagSort)}
          className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-[11px] text-slate-300"
        >
          {TAG_SORTS.map((option) => (
            <option key={option} value={option}>{TAG_SORT_LABELS[option]}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-slate-500 py-3">
          <Loader2 size={16} className="animate-spin" /> Fetching tags...
        </div>
      ) : tags.length === 0 ? (
        <p className="text-[11px] text-amber-400/80 py-3">
          No tags found for <span className="font-mono">{repo}</span> — check the repository name.
        </p>
      ) : (
        <div className={`grid grid-cols-2 gap-2 transition-opacity ${isFetching ? 'opacity-60' : ''}`}>
          {tags.map((tag) => (
            <button
              key={tag}
              onClick={() => onSelect(tag)}
              className={`px-4 py-2 rounded-lg text-left text-xs border transition-all ${
                selected === tag
                  ? 'bg-blue-600 border-blue-400 text-white shadow-lg'
                  : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {selectedOffPage && (
        <p className="text-[11px] text-slate-500 mt-2">
          Selected <span className="font-mono text-blue-300">{selected}</span> — not on this page.
        </p>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <button
            onClick={() => setPage((n) => Math.max(1, n - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs flex items-center gap-1 disabled:opacity-40 disabled:hover:bg-slate-800"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <span className="text-[11px] text-slate-500">Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage((n) => Math.min(totalPages, n + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs flex items-center gap-1 disabled:opacity-40 disabled:hover:bg-slate-800"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
