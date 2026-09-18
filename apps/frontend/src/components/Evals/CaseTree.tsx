import { useState } from 'react'
import { CATEGORY_LABEL } from './shared'
import { matchesFilter, type CaseRow, type CaseStatus, type PersonaGroup } from '../../lib/eval-tree'

interface CaseTreeProps {
  groups: PersonaGroup[]
  filter: 'all' | 'problems'
  isChosen: (name: string) => boolean
  onToggle: (name: string) => void
  onRunOnly: (names: string[]) => void
  onOpen: (name: string) => void
}

const GLYPH: Record<CaseStatus, { mark: string; className: string; label: string }> = {
  pass: { mark: '✓', className: 'text-emerald-400', label: 'passed every time' },
  flaky: { mark: '~', className: 'text-amber-400', label: 'flaky' },
  fail: { mark: '✕', className: 'text-rose-400', label: 'failed every time' },
  running: { mark: '◌', className: 'text-sky-400 animate-pulse', label: 'running' },
  pending: { mark: '·', className: 'text-slate-600', label: 'not run' },
}

function Row({ row, isChosen, onToggle, onRunOnly, onOpen }: {
  row: CaseRow
  isChosen: (name: string) => boolean
  onToggle: (name: string) => void
  onRunOnly: (names: string[]) => void
  onOpen: (name: string) => void
}) {
  const [override, setOverride] = useState<boolean>()
  const open = override ?? true
  const glyph = GLYPH[row.status]

  return (
    <li className="border-t border-slate-800/60 first:border-t-0">
      <div className="flex items-center gap-2 py-1.5 pl-6 pr-2 hover:bg-slate-900/40">
        <input
          type="checkbox"
          className="accent-sky-500"
          checked={isChosen(row.name)}
          onChange={() => onToggle(row.name)}
          aria-label={`Include ${row.name}`}
        />

        <button
          type="button"
          onClick={() => setOverride(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className={`w-4 shrink-0 text-center ${glyph.className}`} title={glyph.label}>
            {glyph.mark}
          </span>
          <span className="truncate font-mono text-sm text-slate-200">{row.name}</span>
          <span className="shrink-0 font-mono text-xs text-slate-500">
            {row.expects ?? 'calls nothing'}
          </span>
          {row.attempts > 0 && (
            <span className={`ml-auto shrink-0 font-mono text-xs ${glyph.className}`}>
              {row.passed}/{row.attempts} · {glyph.label}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => onOpen(row.name)}
          className="shrink-0 text-xs text-slate-500 hover:text-sky-400"
        >
          open
        </button>

        <button
          type="button"
          onClick={() => onRunOnly([row.name])}
          className="shrink-0 text-xs text-slate-500 hover:text-sky-400"
        >
          run
        </button>
      </div>

      {open && (
        <div className="space-y-2 border-l-2 border-slate-800 py-2 pl-10 pr-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {CATEGORY_LABEL[row.category] ?? row.category}
          </p>
          <p className="whitespace-pre-wrap text-sm text-slate-400">{row.say}</p>
          {row.complaints.length > 0 && (
            <ul className="space-y-1">
              {row.complaints.map((complaint) => (
                <li key={complaint} className="font-mono text-xs text-rose-300">{complaint}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

export default function CaseTree({ groups, filter, isChosen, onToggle, onRunOnly, onOpen }: CaseTreeProps) {
  const [collapsed, setCollapsed] = useState<string[]>([])

  return (
    <div className="divide-y divide-slate-800 rounded border border-slate-800">
      {groups.map((group) => {
        const rows = group.rows.filter((row) => matchesFilter(row, filter))
        if (rows.length === 0) return null

        const shut = collapsed.includes(group.persona)
        const glyph = GLYPH[group.status]

        return (
          <section key={group.persona}>
            <div className="flex items-center gap-2 bg-slate-900/60 px-2 py-2">
              <button
                type="button"
                onClick={() => setCollapsed((current) => (shut
                  ? current.filter((name) => name !== group.persona)
                  : [...current, group.persona]))}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className="w-3 shrink-0 text-xs text-slate-500">{shut ? '▸' : '▾'}</span>
                <span className={`w-4 shrink-0 text-center ${glyph.className}`}>{glyph.mark}</span>
                <span className="truncate text-sm font-semibold text-slate-200">{group.persona}</span>
                <span className="shrink-0 text-xs text-slate-500">
                  {rows.length} case{rows.length === 1 ? '' : 's'}
                </span>
                {group.attempts > 0 && (
                  <span className={`ml-auto shrink-0 font-mono text-xs ${glyph.className}`}>
                    {group.passed}/{group.attempts}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => onRunOnly(group.rows.map((row) => row.name))}
                className="shrink-0 text-xs text-slate-500 hover:text-sky-400"
              >
                run persona
              </button>
            </div>

            {!shut && (
              <ul>
                {rows.map((row) => (
                  <Row
                    key={row.name}
                    row={row}
                    isChosen={isChosen}
                    onToggle={onToggle}
                    onRunOnly={onRunOnly}
                    onOpen={onOpen}
                  />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
