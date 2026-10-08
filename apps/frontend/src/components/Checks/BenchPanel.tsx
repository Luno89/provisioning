import { useState } from 'react'
import type { BenchSettings } from '../../api/evals'
import { errorMessage } from '../../api/client'
import { fieldClass, panelClass, quietButton, useBench, useSaveBench } from './shared'

function Settings({ settings }: { settings: BenchSettings }) {
  const [draft, setDraft] = useState(settings)
  const save = useSaveBench()
  const changed = JSON.stringify(draft) !== JSON.stringify(settings)

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
        Run the bench on its own
      </label>
      <label className="flex items-center gap-2">
        after
        <input
          aria-label="Idle minutes before the bench runs"
          type="number" min={1} value={draft.idleMinutes}
          onChange={(event) => setDraft({ ...draft, idleMinutes: Number(event.target.value) })}
          className={`w-16 ${fieldClass}`}
        />
        idle minutes,
      </label>
      <label className="flex items-center gap-2">
        everything every
        <input
          aria-label="Hours between full bench runs"
          type="number" min={1} value={draft.fullEveryHours}
          onChange={(event) => setDraft({ ...draft, fullEveryHours: Number(event.target.value) })}
          className={`w-16 ${fieldClass}`}
        />
        hours, and a changed agent's checks at the next idle moment
      </label>
      <button type="button" disabled={!changed || save.isPending} onClick={() => save.mutate(draft)} className={quietButton}>Save</button>
      {save.error && <span className="text-rose-300">{errorMessage(save.error)}</span>}
    </div>
  )
}

export default function BenchPanel() {
  const bench = useBench()

  return (
    <section className={`flex flex-col gap-3 ${panelClass}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">The bench</h3>
        {bench.data?.state.lastFullAt && (
          <span className="text-xs text-slate-500">every check last ran {new Date(bench.data.state.lastFullAt).toLocaleString()}</span>
        )}
      </div>
      <p className="text-xs text-slate-500">While your model is idle, the bench runs your checks on its own. A check that passed before and fails now is a regression: you get a toast, and it shows on the check.</p>
      {bench.data && <Settings key={JSON.stringify(bench.data.settings)} settings={bench.data.settings} />}
      {bench.error && <p className="text-xs text-rose-300">{errorMessage(bench.error)}</p>}
    </section>
  )
}
