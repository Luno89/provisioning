import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Lock, Plus, Search, X } from 'lucide-react'
import type { Agent, GrantableTool } from '../../api/agents'
import type { RequiredGrant } from '../../api/procedures'
import { requirementFor, toolProblem } from './agent-forms'
import { toolChoices } from '../../lib/tool-grants'

const groupTitle = 'px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500'

export default function ToolGrants({ granted, grantable, requires, procedure, environment, onChange }: {
  granted: readonly string[]
  grantable: readonly GrantableTool[]
  requires: readonly RequiredGrant[]
  procedure: string
  environment: Agent['environment']
  onChange: (next: string[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const choices = toolChoices(granted, grantable, search)
  const available = choices.available.reduce((count, group) => count + group.items.length, 0)

  const remove = (name: string) => onChange(granted.filter((one) => one !== name))
  const add = (name: string) => onChange([...granted, name])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">{granted.length} tool{granted.length === 1 ? '' : 's'} granted</span>
        <button
          type="button"
          onClick={() => setAdding(!adding)}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/20 px-2.5 py-1 text-xs font-semibold text-[var(--leaf-light)] hover:bg-[var(--leaf-stem)]/30"
        >
          {adding ? <X size={12} /> : <Plus size={12} />} {adding ? 'Done adding' : 'Add tools'}
        </button>
      </div>

      {adding && (
        <section aria-label="Tools it could be given" className="rounded-md border border-[var(--leaf-stem)]/40 bg-[var(--bark-900)]/70">
          <label className="m-2 flex items-center gap-1.5 rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1">
            <Search size={12} className="text-slate-500" />
            <input autoFocus aria-label="Find a tool to add" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find by name or what it does" className="w-full bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-600" />
          </label>
          <div className="max-h-80 overflow-y-auto pb-2">
            {available === 0 && <p className="px-3 py-2 text-xs text-slate-500">{search ? 'No tool it lacks matches that.' : 'It already holds every tool.'}</p>}
            {choices.available.map((group) => (
              <div key={group.id}>
                <p className={groupTitle}>{group.title}</p>
                {group.items.map((tool) => {
                  const refusal = toolProblem(tool, environment)
                  return (
                    <button
                      key={tool.name}
                      type="button"
                      onClick={() => add(tool.name)}
                      aria-label={`Add ${tool.name}`}
                      className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-[var(--bark-800)]"
                    >
                      <Plus size={12} className="shrink-0 text-[var(--leaf)]" />
                      <span className="w-48 shrink-0 truncate font-mono text-slate-200">{tool.name}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-500">{tool.summary}</span>
                      {refusal && <span className="shrink-0 text-[11px] text-amber-300">{refusal}</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Tools it holds" className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
        {granted.length === 0 && <p className="px-3 py-3 text-xs text-slate-500">It holds no tools. It can still answer, but cannot act.</p>}
        {choices.granted.map((group) => (
          <div key={group.id} className="pb-1">
            <p className={groupTitle}>{group.title}</p>
            {group.items.map((tool) => {
              const required = requirementFor(requires, 'tool', tool.name)
              const refusal = toolProblem(tool, environment)
              return (
                <div key={tool.name} className="group flex items-center gap-2 px-3 py-1 text-xs hover:bg-[var(--bark-800)]/50">
                  <Link to="/studio/tools/$name" params={{ name: tool.name }} className="w-48 shrink-0 truncate font-mono text-slate-200 hover:text-sky-300 hover:underline">{tool.name}</Link>
                  <span className="min-w-0 flex-1 truncate text-slate-500">{tool.summary}</span>
                  {refusal && <span className="shrink-0 text-[11px] text-amber-300">{refusal}</span>}
                  {required ? (
                    <span title={`${procedure} needs it — ${required.why}`} className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-300"><Lock size={11} /> {procedure} needs it</span>
                  ) : (
                    <button type="button" onClick={() => remove(tool.name)} aria-label={`Take away ${tool.name}`} title="Take it away" className="shrink-0 rounded p-0.5 text-slate-500 opacity-60 hover:bg-[var(--bark-700)] hover:text-red-300 group-hover:opacity-100">
                      <X size={12} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
        {choices.unknown.length > 0 && (
          <div className="pb-1">
            <p className={`${groupTitle} text-amber-300`}>No longer in the catalogue</p>
            {choices.unknown.map((name) => (
              <div key={name} className="flex items-center gap-2 px-3 py-1 text-xs">
                <span className="w-48 shrink-0 truncate font-mono text-amber-200">{name}</span>
                <span className="min-w-0 flex-1 text-slate-500">granted, but no tool by this name exists any more</span>
                <button type="button" onClick={() => remove(name)} aria-label={`Take away ${name}`} className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-[var(--bark-700)] hover:text-red-300"><X size={12} /></button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
