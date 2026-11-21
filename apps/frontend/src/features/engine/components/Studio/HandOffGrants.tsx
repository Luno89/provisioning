import { Lock, Plus, RotateCcw, X } from 'lucide-react'
import type { Agent, SourcedTool } from '../../api/agents'
import type { RequiredGrant } from '../../api/procedures'
import { requirementFor } from './agent-forms'
import { toolOrigins } from '../../lib/tool-grants'

const ORIGIN_WORDS = { 'built-in': 'built in', yours: 'granted by you' } as const

const groupTitle = 'px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500'

export default function HandOffGrants({ self, held, sources, agents, requires, procedure, onChange }: {
  self: string
  held: readonly string[]
  sources: readonly SourcedTool[]
  agents: readonly Agent[]
  requires: readonly RequiredGrant[]
  procedure: string
  onChange: (next: string[]) => void
}) {
  const origins = toolOrigins(held, sources)
  const others = agents.filter((one) => one.slug !== self && !held.includes(one.slug) && !origins.takenAway.includes(one.slug))
  const revoke = (slug: string) => onChange(held.filter((one) => one !== slug))
  const give = (slug: string) => onChange([...held, slug])

  return (
    <div className="space-y-2">
      <section aria-label="Agents it may hand work to" className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
        {held.length === 0 && <p className="px-3 py-3 text-xs text-slate-500">It hands work to no other agent.</p>}
        {held.map((slug) => {
          const required = requirementFor(requires, 'agent', slug)
          return (
            <div key={slug} className="group flex items-center gap-2 px-3 py-1 text-xs hover:bg-[var(--bark-800)]/50">
              <span className="min-w-0 flex-1 truncate text-slate-200">may hand work to {slug}</span>
              {origins.of[slug] && <span className={`shrink-0 text-[10px] ${origins.of[slug] === 'yours' ? 'text-sky-300' : 'text-slate-500'}`}>{ORIGIN_WORDS[origins.of[slug]!]}</span>}
              {required ? (
                <span title={`${procedure} needs it — ${required.why}`} className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-300"><Lock size={11} /> {procedure} needs it</span>
              ) : (
                <button type="button" onClick={() => revoke(slug)} aria-label={`Revoke ${slug}`} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-[var(--bark-700)] hover:text-red-300">
                  <X size={11} /> Revoke
                </button>
              )}
            </div>
          )
        })}
      </section>
      {origins.takenAway.length > 0 && (
        <section aria-label="Hand-offs taken away" className="rounded-md border border-[var(--bark-700)]">
          <p className={groupTitle}>Built in, taken away by you</p>
          {origins.takenAway.map((slug) => (
            <div key={slug} className="flex items-center gap-2 px-3 py-1 text-xs">
              <span className="min-w-0 flex-1 truncate text-slate-500 line-through">{slug}</span>
              <button type="button" onClick={() => give(slug)} aria-label={`Give back ${slug}`} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-[var(--bark-700)] hover:text-emerald-300">
                <RotateCcw size={11} /> Give back
              </button>
            </div>
          ))}
        </section>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {others.map((one) => (
            <button key={one.slug} type="button" onClick={() => give(one.slug)} aria-label={`Let it hand work to ${one.slug}`} className="flex items-center gap-1 rounded border border-[var(--bark-700)] px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-emerald-300">
              <Plus size={11} /> {one.slug}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
