import { useState } from 'react'
import { Cloud, Loader2, LogOut, Trash2 } from 'lucide-react'
import { usePoolAdmin, useRemovePoolInstance, useSetPoolTrialDays, useSetPoolTrialEnd, type PoolInstanceRow } from '../api/instances'
import { errorMessage } from '../api/client'

const STATE: Record<PoolInstanceRow['status'], string> = {
  waiting: 'waiting',
  joined: 'joined',
  installing: 'setting up',
  ready: 'running',
  failed: 'failed',
  paused: 'stopped, trial ended',
}

const dateOnly = (iso: string) => iso.slice(0, 10)
const shown = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function TrialRow({ row }: { row: PoolInstanceRow }) {
  const [end, setEnd] = useState(dateOnly(row.trialEndsAt))
  const save = useSetPoolTrialEnd()
  const remove = useRemovePoolInstance()
  const [deleting, setDeleting] = useState(false)
  const [typed, setTyped] = useState('')
  const changed = end !== dateOnly(row.trialEndsAt)
  return (
    <tr className="border-t border-[var(--bark-700)] text-xs">
      <td className="py-2 pr-3 font-mono text-slate-200">{row.name}</td>
      <td className="py-2 pr-3 text-slate-300">{row.owner}</td>
      <td className="py-2 pr-3 text-slate-300" title={row.detail}>{STATE[row.status]}</td>
      <td className="py-2 pr-3 text-slate-400">{shown(row.startedAt)}</td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
          <input
            type="date"
            aria-label={`Trial end for ${row.name}`}
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            className="rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-1.5 py-0.5 text-xs text-slate-100"
          />
          {changed && (
            <button
              type="button"
              onClick={() => save.mutate({ id: row.id, trialEndsAt: `${end}T${row.trialEndsAt.slice(11)}` })}
              disabled={save.isPending}
              className="rounded bg-[var(--leaf-stem)] px-2 py-0.5 text-xs text-white disabled:opacity-50"
            >
              {save.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
            </button>
          )}
        </div>
        {save.isError && <p role="alert" className="mt-1 text-[11px] text-rose-300">{errorMessage(save.error)}</p>}
      </td>
      <td className="py-2">
        {row.detail === 'Being deleted' ? (
          <span className="text-[11px] text-slate-500">being deleted</span>
        ) : deleting ? (
          <div className="flex items-center gap-1.5">
            <input
              aria-label={`Type ${row.name} to delete it`}
              placeholder={row.name}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className="w-24 rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-1.5 py-0.5 font-mono text-xs text-slate-100"
            />
            <button
              type="button"
              onClick={() => remove.mutate({ id: row.id, confirm: typed })}
              disabled={typed !== row.name || remove.isPending}
              className="rounded bg-rose-600 px-2 py-0.5 text-xs text-white disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setDeleting(true)} aria-label={`Delete ${row.name}`} className="text-slate-500 hover:text-rose-300"><Trash2 size={13} /></button>
        )}
        {remove.isError && <p role="alert" className="mt-1 text-[11px] text-rose-300">{errorMessage(remove.error)}</p>}
      </td>
    </tr>
  )
}

export default function PoolAdmin({ onLogout }: { onLogout: () => void }) {
  const pool = usePoolAdmin()
  const setDays = useSetPoolTrialDays()
  const [days, setDaysValue] = useState<string | undefined>(undefined)
  const current = days ?? (pool.data ? String(pool.data.trialDays) : '')

  return (
    <div className="min-h-screen bg-[var(--bark-900)] p-6 text-slate-100">
      <div className="mx-auto max-w-4xl space-y-5 rounded-2xl border border-[var(--bark-700)] bg-[var(--bark-800)] p-6">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-2 text-sm font-semibold"><Cloud size={16} /> Koala's servers</h1>
          <button type="button" onClick={onLogout} className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"><LogOut size={12} /> Sign out</button>
        </div>
        {pool.isPending && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading the pool…</p>}
        {pool.isError && <p role="alert" className="text-xs text-rose-300">{errorMessage(pool.error)}</p>}
        {pool.data && (
          <>
            <p className="text-xs text-slate-400">{pool.data.instances.filter((row) => row.status !== 'failed').length} of {pool.data.slots} places in use.</p>
            <div className="space-y-1">
              <label htmlFor="trial-days" className="block text-xs text-slate-300">How long a new trial lasts, in days</label>
              <div className="flex items-center gap-2">
                <input
                  id="trial-days"
                  type="number"
                  min={1}
                  max={365}
                  value={current}
                  onChange={(event) => setDaysValue(event.target.value)}
                  className="w-20 rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-1.5 py-0.5 text-xs text-slate-100"
                />
                {current !== String(pool.data.trialDays) && (
                  <button
                    type="button"
                    onClick={() => setDays.mutate(Number(current), { onSuccess: () => setDaysValue(undefined) })}
                    disabled={setDays.isPending}
                    className="rounded bg-[var(--leaf-stem)] px-2 py-0.5 text-xs text-white disabled:opacity-50"
                  >
                    Save
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-500">This root started with {pool.data.defaultTrialDays} days. A trial already running keeps its end; change it below.</p>
              {setDays.isError && <p role="alert" className="text-[11px] text-rose-300">{errorMessage(setDays.error)}</p>}
            </div>
            {pool.data.instances.length === 0 ? (
              <p className="text-xs text-slate-400">Nobody is trying Koala here yet.</p>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="pb-1 pr-3 font-medium">Name</th>
                    <th className="pb-1 pr-3 font-medium">Person</th>
                    <th className="pb-1 pr-3 font-medium">State</th>
                    <th className="pb-1 pr-3 font-medium">Started</th>
                    <th className="pb-1 pr-3 font-medium">Trial ends</th>
                    <th className="pb-1 font-medium" />
                  </tr>
                </thead>
                <tbody>{pool.data.instances.map((row) => <TrialRow key={row.id} row={row} />)}</tbody>
              </table>
            )}
            <p className="text-[11px] text-slate-500">A stopped instance is deleted 30 days after its trial ended. Moving the end into the future starts it again. Deleting one removes it and all its work at once, and cannot be undone.</p>
          </>
        )}
      </div>
    </div>
  )
}
