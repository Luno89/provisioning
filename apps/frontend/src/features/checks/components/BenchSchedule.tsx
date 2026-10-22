import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getBench, saveBench, type BenchSettings } from '../api'
import { errorMessage } from '../../../api/client'
import { evalKeys, fieldClass, quietButton, useBench } from '../shared'

type Schedule = Pick<BenchSettings, 'idleMinutes' | 'fullEveryHours'>

function ScheduleForm({ schedule }: { schedule: Schedule }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState(schedule)
  const save = useMutation({
    mutationFn: async (next: Schedule) => saveBench({ ...(await getBench()).settings, ...next }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: evalKeys.bench }) },
  })
  const changed = draft.idleMinutes !== schedule.idleMinutes || draft.fullEveryHours !== schedule.fullEveryHours

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
      <label className="flex items-center gap-1.5">
        Starts after
        <input
          aria-label="Idle minutes before the bench runs"
          type="number" min={1} value={draft.idleMinutes}
          onChange={(event) => setDraft({ ...draft, idleMinutes: Number(event.target.value) })}
          className={`w-14 ${fieldClass}`}
        />
        idle minutes; runs everything every
      </label>
      <label className="flex items-center gap-1.5">
        <input
          aria-label="Hours between full bench runs"
          type="number" min={1} value={draft.fullEveryHours}
          onChange={(event) => setDraft({ ...draft, fullEveryHours: Number(event.target.value) })}
          className={`w-14 ${fieldClass}`}
        />
        hours, otherwise only a changed agent's checks.
      </label>
      <button type="button" disabled={!changed || save.isPending} onClick={() => save.mutate(draft)} className={quietButton}>Save</button>
      {save.error && <span className="text-rose-300">{errorMessage(save.error)}</span>}
    </div>
  )
}

export default function BenchSchedule() {
  const bench = useBench()
  if (bench.error) return <p className="text-[11px] text-rose-300">{errorMessage(bench.error)}</p>
  if (!bench.data) return null
  const { idleMinutes, fullEveryHours } = bench.data.settings
  return (
    <div className="space-y-1">
      <ScheduleForm key={`${idleMinutes}/${fullEveryHours}`} schedule={{ idleMinutes, fullEveryHours }} />
      {bench.data.state.lastFullAt && <p className="text-[11px] text-slate-500">Every check last ran {new Date(bench.data.state.lastFullAt).toLocaleString()}.</p>}
    </div>
  )
}
