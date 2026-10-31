import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react'
import { MailReportLines } from '../../../shared/components/MailReport'
import type { ServerOrder } from '../api/server-orders'

export function ServerOrderMail({ order }: { order: ServerOrder }) {
  const { reverseDns, mail } = order
  if (!reverseDns && !mail) return null
  return (
    <div className="space-y-2 rounded-md border border-[var(--bark-700)] p-3" data-testid="server-order-mail">
      <div className="text-[12px] font-semibold text-slate-100">Root's mail</div>
      {reverseDns && (
        <p className="flex items-start gap-1.5 text-[11px] text-slate-300" data-testid="server-order-reverse-dns">
          {reverseDns.state === 'waiting' ? <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-blue-300" />
            : reverseDns.state === 'refused' ? <TriangleAlert size={12} className="mt-0.5 shrink-0 text-amber-300" />
            : <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-300" />}
          <span>Reverse DNS: {reverseDns.said}</span>
        </p>
      )}
      {mail && <MailReportLines report={mail} />}
      {mail && <p className="text-[11px] text-slate-500">{mail.problems.length ? `${mail.problems.length} thing${mail.problems.length === 1 ? '' : 's'} to fix before root's mail is relied on.` : 'Nothing stands in the way of root\'s mail.'} Root's admin page checks again on asking.</p>}
    </div>
  )
}
