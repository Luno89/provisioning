import { useState } from 'react'
import { Check, Copy, Link2 } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { shareUrl } from '../api/files'
import { SHARE_DAYS, type FileScope, type ShareDays } from '../types'
import { useShareFile } from '../shared'

const DAYS_SAID: Record<ShareDays, string> = { 1: 'a day', 7: 'a week', 30: 'a month' }

export default function ShareFile({ scope, path }: { scope: FileScope; path: string }) {
  const share = useShareFile(scope)
  const [days, setDays] = useState<ShareDays>(7)
  const [copied, setCopied] = useState(false)
  const url = share.data ? shareUrl(share.data.id, window.location.origin) : undefined

  return (
    <div className="space-y-1.5 text-[12px]" data-testid="share-file">
      <div className="flex flex-wrap items-center gap-2">
        <Link2 size={12} className="text-sky-400" />
        <span className="text-slate-300">A link anyone can open, for</span>
        <select aria-label="How long the link lasts" value={days} onChange={(event) => setDays(Number(event.target.value) as ShareDays)} className="rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-1.5 py-0.5 text-[12px] text-slate-200">
          {SHARE_DAYS.map((choice) => <option key={choice} value={choice}>{DAYS_SAID[choice]}</option>)}
        </select>
        <button type="button" onClick={() => { setCopied(false); share.mutate({ path, days }) }} disabled={share.isPending} className="rounded bg-[var(--leaf-stem)] px-2 py-0.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50">
          {share.isPending ? 'Making…' : 'Make the link'}
        </button>
      </div>
      {url && (
        <div className="flex items-center gap-1.5">
          <input readOnly aria-label="The link" value={url} onFocus={(event) => event.target.select()} className="min-w-0 flex-1 rounded border border-[var(--bark-600)] bg-[var(--bark-950)] px-1.5 py-0.5 font-mono text-[11px] text-slate-200" />
          <button
            type="button"
            aria-label="Copy the link"
            onClick={() => { void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => setCopied(false)) }}
            className="rounded p-1 text-slate-400 hover:bg-[var(--bark-700)] hover:text-slate-100"
          >
            {copied ? <Check size={12} className="text-emerald-300" /> : <Copy size={12} />}
          </button>
        </div>
      )}
      {share.isError && <p role="alert" className="text-[11px] text-red-300">{errorMessage(share.error)}</p>}
    </div>
  )
}
