import { CheckCircle2, CircleHelp, TriangleAlert } from 'lucide-react'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * `MailLine` and `MailReport` in `apps/backend/src/platform/lib/mail-reputation.ts` are the authority;
 * only the fields shown here are mirrored.
 */
export interface MailLine {
  mark: 'ok' | 'problem' | 'unknown'
  said: string
}

export interface MailReport {
  check: { domain: string; host: string; ip?: string; checkedAt: string }
  lines: MailLine[]
  problems: string[]
}

const MARK = {
  ok: { Icon: CheckCircle2, style: 'text-emerald-300', label: 'fine' },
  problem: { Icon: TriangleAlert, style: 'text-amber-300', label: 'to fix' },
  unknown: { Icon: CircleHelp, style: 'text-slate-400', label: 'could not be checked' },
} as const

export function MailReportLines({ report }: { report: MailReport }) {
  return (
    <ul className="space-y-1 text-[11px]" aria-label="Root's mail">
      {report.lines.map((line) => {
        const { Icon, style, label } = MARK[line.mark]
        return (
          <li key={line.said} className="flex items-start gap-1.5 text-slate-300">
            <Icon size={12} className={`mt-0.5 shrink-0 ${style}`} aria-label={label} />
            <span>{line.said}</span>
          </li>
        )
      })}
    </ul>
  )
}
