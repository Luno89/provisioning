import { Link } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { useDependencies } from '../api/workspaceDependencies'

interface NeedsPickerProps {
  value: readonly string[]
  onChange: (needs: string[]) => void
  label?: string | undefined
}

export default function NeedsPicker({ value, onChange, label = 'Workspace dependencies it needs' }: NeedsPickerProps) {
  const dependencies = useDependencies()
  const known = dependencies.data ?? []
  const left = known.filter((dependency) => !value.includes(dependency.name))
  const summaryOf = (name: string) => known.find((dependency) => dependency.name === name)?.summary

  return (
    <div className="space-y-1.5" data-testid="needs-picker">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.length === 0 && <span className="text-[11px] text-slate-500">nothing installed beyond the base workspace</span>}
        {value.map((name) => (
          <span key={name} title={summaryOf(name) ?? `${name} is not in your dependencies`} className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${summaryOf(name) ? 'border-[var(--bark-600)] text-slate-200' : 'border-rose-500/60 text-rose-200'}`}>
            {name}
            <button type="button" aria-label={`Stop needing ${name}`} onClick={() => onChange(value.filter((entry) => entry !== name))} className="text-slate-500 hover:text-slate-200">
              <X size={11} />
            </button>
          </span>
        ))}
        <select
          aria-label={`Add to ${label.toLowerCase()}`}
          value=""
          disabled={dependencies.isPending || left.length === 0}
          onChange={(event) => { if (event.target.value) onChange([...value, event.target.value]) }}
          className="rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-1.5 py-0.5 text-[11px] text-slate-300"
        >
          <option value="">{dependencies.isPending ? 'loading…' : 'add a dependency…'}</option>
          {left.map((dependency) => <option key={dependency.name} value={dependency.name}>{dependency.name} — {dependency.summary}</option>)}
        </select>
      </div>
      <p className="text-[10px] text-slate-500">
        What its workspace has to install for it to run. Not there? <Link to="/studio/dependencies" className="underline hover:text-slate-300">Add a workspace dependency</Link>.
      </p>
    </div>
  )
}
