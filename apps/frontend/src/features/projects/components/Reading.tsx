import { Loader2 } from 'lucide-react'

export function Reading({ label, className = '' }: { label: string; className?: string }) {
  return (
    <p role="status" aria-live="polite" className={`flex items-center gap-2 text-[12px] text-slate-500 ${className}`}>
      <Loader2 size={13} className="shrink-0 animate-spin text-sky-400" aria-hidden="true" />
      {label}
    </p>
  )
}

export default Reading
