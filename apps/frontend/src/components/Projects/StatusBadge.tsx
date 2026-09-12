import { Clock, Loader2, XCircle, CheckCircle2, AlertTriangle } from 'lucide-react'

export const PROJECT_STATUS: Record<string, { icon: any; className: string; label: string }> = {
  'no-build': { icon: Clock, className: 'text-slate-400 bg-slate-500/10 border-slate-700/50', label: 'No build yet' },
  building: { icon: Loader2, className: 'text-blue-400 bg-blue-500/10 border-blue-500/30', label: 'Building' },
  'build-failed': { icon: XCircle, className: 'text-rose-400 bg-rose-500/10 border-rose-500/20', label: 'Build Failed' },
  built: { icon: CheckCircle2, className: 'text-slate-300 bg-slate-500/10 border-slate-700/50', label: 'Built' },
  deploying: { icon: Loader2, className: 'text-blue-400 bg-blue-500/10 border-blue-500/30', label: 'Deploying' },
  'deploy-failed': { icon: XCircle, className: 'text-rose-400 bg-rose-500/10 border-rose-500/20', label: 'Deploy Failed' },
  unhealthy: { icon: AlertTriangle, className: 'text-amber-400 bg-amber-500/10 border-amber-500/20', label: 'Unhealthy' },
  running: { icon: CheckCircle2, className: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', label: 'Running' },
}

export function ProjectStatusBadge({ status, reason }: { status?: string | undefined; reason?: string | undefined }) {
  const s = PROJECT_STATUS[status || 'no-build'] || PROJECT_STATUS['no-build']!
  const Icon = s.icon
  const spinning = status === 'building' || status === 'deploying'
  return (
    <span
      title={reason || undefined}
      className={`text-[11px] font-medium font-mono px-2 py-0.5 rounded-md border flex items-center gap-1.5 w-fit shrink-0 ${s.className}`}
    >
      <Icon size={11} className={spinning ? 'animate-spin' : ''} /> {s.label}
    </span>
  )
}
