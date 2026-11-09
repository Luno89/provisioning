interface TypedTagProps {
  why: string
  value: string
  onChange: (tag: string) => void
}

export function TypedTag({ why, value, onChange }: TypedTagProps) {
  return (
    <div className="space-y-2 py-2">
      <p role="status" className="text-[11px] text-amber-400/80">{why}</p>
      <label className="block text-[11px] text-slate-400">
        Tag
        <input
          aria-label="Tag"
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="type the tag to use"
          className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200"
        />
      </label>
    </div>
  )
}
