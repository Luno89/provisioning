import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Hand, Loader2, Square } from 'lucide-react'
import { cancelRunning, pauseBench, pauseKeeper, runningKeys, type RunningItem } from '../../api/running'
import { errorMessage } from '../../api/client'
import { ago } from '../home-summary'
import { useRunning } from './useRunning'
import { hashFor } from './opens'
import { waitingText } from './shared'

function Switch({ label, explain, paused, onChange, busy }: { label: string; explain: string; paused: boolean | undefined; onChange: (paused: boolean) => void; busy: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3">
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-slate-200">{label}: {paused === undefined ? '…' : paused ? 'paused' : 'running'}</div>
        <p className="mt-0.5 text-[11px] text-slate-500">{explain}</p>
      </div>
      <button
        type="button"
        disabled={busy || paused === undefined}
        onClick={() => onChange(!paused)}
        className="shrink-0 rounded border border-[var(--bark-600)] px-2.5 py-1 text-[11px] text-slate-200 hover:bg-[var(--bark-700)] disabled:opacity-50"
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  )
}

function Row({ item }: { item: RunningItem }) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const cancel = useMutation({
    mutationFn: () => cancelRunning(item.workflowId),
    onSuccess: () => { setConfirming(false); void qc.invalidateQueries({ queryKey: runningKeys.view() }) },
  })
  const stoppable = item.cancel.via !== 'none'

  return (
    <li className="space-y-1 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3" data-testid="running-item">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <a href={hashFor(item.opens)} className="text-[12px] font-semibold text-slate-100 hover:underline">{item.title}</a>
          <div className="text-[11px] text-slate-500">
            started {ago(item.since)}
            {item.asking?.length || item.waitsFor?.length ? <span className="ml-2 inline-flex items-center gap-1 text-amber-300"><Hand size={10} /> {waitingText(item)}</span> : null}
          </div>
        </div>
        {stoppable && !confirming && (
          <button type="button" onClick={() => setConfirming(true)} className="shrink-0 flex items-center gap-1 rounded border border-[var(--bark-600)] px-2 py-1 text-[11px] text-slate-300 hover:bg-[var(--bark-700)]">
            <Square size={10} /> Cancel
          </button>
        )}
      </div>
      {!stoppable && 'why' in item.cancel && <p className="text-[11px] text-slate-500">It cannot be cancelled: {item.cancel.why}.</p>}
      {confirming && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-slate-300">Cancel it? It ends what it is doing and stops; whatever it had not finished is left for later.</span>
          <button type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending} className="rounded bg-rose-600 px-2 py-1 font-semibold text-white disabled:opacity-50">
            {cancel.isPending ? <Loader2 size={11} className="animate-spin" /> : 'Yes, cancel it'}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="rounded border border-slate-600 px-2 py-1 text-slate-300">Keep it running</button>
        </div>
      )}
      {cancel.isSuccess && <p className="text-[11px] text-slate-400">Cancelling — it runs its own ending, then goes from this list.</p>}
      {cancel.isError && <p className="text-[11px] text-rose-400">{errorMessage(cancel.error)}</p>}
    </li>
  )
}

export default function RunningTab() {
  const qc = useQueryClient()
  const { data, error } = useRunning()
  const refresh = () => void qc.invalidateQueries({ queryKey: runningKeys.view() })
  const bench = useMutation({ mutationFn: pauseBench, onSuccess: refresh })
  const keeper = useMutation({ mutationFn: pauseKeeper, onSuccess: refresh })
  const benchRunning = data?.items.some((item) => item.kind === 'bench')

  return (
    <div className="max-w-3xl space-y-4" data-testid="running-tab">

        <section className="space-y-2">
          <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Background work</h2>
          <Switch
            label="The bench"
            explain={`Runs your checks on its own when the model is idle, and after an agent changes. Paused, it starts nothing new.${data?.bench.paused === false && benchRunning ? ' A bench run is going now; cancel it below to stop it too.' : ''}`}
            paused={data?.bench.paused}
            busy={bench.isPending}
            onChange={(paused) => bench.mutate(paused)}
          />
          <Switch
            label="The memory keeper"
            explain={`Reads conversations once they go quiet, settled stories and runs that failed, and keeps what is worth remembering. Paused, it holds them in order and reads them all when resumed.${data?.keeper.held ? ` ${data.keeper.held} ${data.keeper.held === 1 ? 'is' : 'are'} held now.` : ''}`}
            paused={data?.keeper.paused}
            busy={keeper.isPending}
            onChange={(paused) => keeper.mutate(paused)}
          />
          {bench.isError && <p className="text-[11px] text-rose-400">{errorMessage(bench.error)}</p>}
          {keeper.isError && <p className="text-[11px] text-rose-400">{errorMessage(keeper.error)}</p>}
        </section>

        <section className="space-y-2">
          <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Running now</h2>
          {error && <p className="text-[12px] text-rose-400">{errorMessage(error)}</p>}
          {!data && !error && <p className="text-[12px] text-slate-500">Reading what runs…</p>}
          {data && data.items.length === 0 && <p className="text-[12px] text-slate-500">Nothing is running.</p>}
          {data && data.items.length > 0 && <ul className="space-y-2">{data.items.map((item) => <Row key={item.workflowId} item={item} />)}</ul>}
        </section>
    </div>
  )
}
