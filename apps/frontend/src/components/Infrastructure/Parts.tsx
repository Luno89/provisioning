import type { ReactNode } from 'react'
import type { WorkloadState } from '../../api/infrastructure'
import { WORKLOAD_LOOK } from './shared'

export function WorkloadBadge({ state }: { state: WorkloadState | 'absent' }) {
  const look = WORKLOAD_LOOK[state]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold ${look.text}`} data-testid="workload-badge">
      <span className={`h-2 w-2 rounded-full ${look.dot}`} aria-hidden="true" />
      {look.label}
    </span>
  )
}

export function QuietButton({ children, onClick, danger = false, disabled = false, label }: { children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] disabled:opacity-50 ${danger ? 'border-rose-900/70 text-rose-300 hover:bg-rose-950/50' : 'border-[var(--bark-600)] text-slate-300 hover:bg-[var(--bark-700)]'}`}
    >
      {children}
    </button>
  )
}

export function Card({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div className="space-y-2 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3" data-testid={testId}>{children}</div>
}
