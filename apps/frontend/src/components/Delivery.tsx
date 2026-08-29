import { Check, X, Loader2, Circle, AlertTriangle, Minus } from 'lucide-react';

export interface DeliveryStage {
  key: string;
  label: string;
  state: 'pending' | 'active' | 'done' | 'failed' | 'warn' | 'skipped';
  detail: string;
}

const STATE = {
  done: { icon: Check, dot: 'bg-[var(--leaf)]', text: 'text-[var(--leaf)]' },
  active: { icon: Loader2, dot: 'bg-blue-400', text: 'text-blue-300' },
  failed: { icon: X, dot: 'bg-red-500', text: 'text-red-400' },
  warn: { icon: AlertTriangle, dot: 'bg-amber-500', text: 'text-amber-400' },
  pending: { icon: Circle, dot: 'bg-[var(--bark-600)]', text: 'text-slate-500' },
  skipped: { icon: Minus, dot: 'bg-[var(--bark-600)]', text: 'text-slate-600' },
} as const;

export default function Delivery({ stages, projectName }: { stages?: DeliveryStage[] | undefined; projectName?: string | undefined }) {
  if (!stages?.length || stages.every((s) => s.state === 'pending' || s.state === 'skipped')) return null;

  return (
    <div className="mb-3 rounded-xl border border-[var(--bark-600)] bg-[var(--bark-900)]/60 px-4 py-3">
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">What happened to this request</span>
        {projectName && <span className="text-[10px] font-mono text-slate-600 truncate max-w-[45%]">{projectName}</span>}
      </div>
      <ol className="flex flex-wrap items-stretch gap-x-1 gap-y-2">
        {stages.map((s, i) => {
          const style = STATE[s.state] ?? STATE.pending;
          const Icon = style.icon;
          return (
            <li key={s.key} className="flex items-center gap-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${style.dot}`}>
                  <Icon size={10} className={`text-slate-950 ${s.state === 'active' ? 'animate-spin' : ''}`} />
                </span>
                <div className="flex flex-col min-w-0">
                  <span className={`text-[11px] font-bold leading-tight ${style.text}`}>{s.label}</span>
                  <span className="text-[10px] text-slate-500 leading-tight truncate" title={s.detail}>{s.detail}</span>
                </div>
              </div>
              {i < stages.length - 1 && <span className="mx-2 h-px w-5 bg-[var(--bark-600)] shrink-0" />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
