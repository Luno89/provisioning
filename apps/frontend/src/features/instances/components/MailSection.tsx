import { Loader2, RefreshCw } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { MailReportLines } from '../../../shared/components/MailReport'
import { useCheckMailReputation, useMailReputation } from '../api/mail-reputation'

const shown = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export function MailSection() {
  const mail = useMailReputation()
  const check = useCheckMailReputation()
  const view = mail.data
  const checking = check.isPending || Boolean(view?.checking)
  const report = view?.report

  return (
    <section id="mail" className="space-y-3" aria-labelledby="mail-heading">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="mail-heading" className="text-sm font-semibold">Root's mail</h2>
        <span className="text-xs text-slate-400">
          {checking ? 'Checking…' : report ? `Checked ${shown(report.check.checkedAt)}${report.check.ip ? ` for ${report.check.ip}` : ''}` : 'Not checked yet'}
        </span>
        <button
          type="button"
          onClick={() => check.mutate()}
          disabled={checking}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--bark-700)] px-2.5 py-1 text-xs text-slate-200 hover:bg-[var(--bark-700)] disabled:opacity-50"
        >
          {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Check now
        </button>
      </div>
      <p className="text-xs text-slate-400">
        Whether mail root sends can reach inboxes: its mail name points at it and back (reverse DNS), port 25 lets it out, and its address is on none of the blocklists mailbox providers read, asked through this server's own resolver.
      </p>
      {mail.isError && <p role="alert" className="text-xs text-red-300">{errorMessage(mail.error)}</p>}
      {check.isError && <p role="alert" className="text-xs text-red-300">{errorMessage(check.error)}</p>}
      {report && <MailReportLines report={report} />}
      {report && report.problems.length === 0 && <p className="text-xs text-emerald-300">Nothing stands in the way of root's mail.</p>}
    </section>
  )
}
