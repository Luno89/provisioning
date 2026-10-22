import { type ReactNode } from 'react';
import { Info, Lightbulb, Bookmark, AlertTriangle, ShieldAlert } from 'lucide-react';

export type AlertType = 'note' | 'tip' | 'important' | 'warning' | 'caution';

const ALERT_CONFIGS: Record<AlertType, { label: string; icon: typeof Info; borderCls: string; bgCls: string; textCls: string }> = {
  note: {
    label: 'Note',
    icon: Info,
    borderCls: 'border-blue-500',
    bgCls: 'bg-blue-950/20',
    textCls: 'text-blue-400',
  },
  tip: {
    label: 'Tip',
    icon: Lightbulb,
    borderCls: 'border-emerald-500',
    bgCls: 'bg-emerald-950/20',
    textCls: 'text-emerald-400',
  },
  important: {
    label: 'Important',
    icon: Bookmark,
    borderCls: 'border-purple-500',
    bgCls: 'bg-purple-950/20',
    textCls: 'text-purple-400',
  },
  warning: {
    label: 'Warning',
    icon: AlertTriangle,
    borderCls: 'border-amber-500',
    bgCls: 'bg-amber-950/20',
    textCls: 'text-amber-400',
  },
  caution: {
    label: 'Caution',
    icon: ShieldAlert,
    borderCls: 'border-rose-500',
    bgCls: 'bg-rose-950/20',
    textCls: 'text-rose-400',
  },
};

export default function AlertBlock({
  type,
  children,
}: {
  type: AlertType;
  children: ReactNode;
}) {
  const config = ALERT_CONFIGS[type] || ALERT_CONFIGS.note;
  const Icon = config.icon;

  return (
    <div className={`my-3 p-3.5 rounded-xl border-l-4 ${config.borderCls} ${config.bgCls} border border-slate-700/40 text-xs shadow-sm`}>
      <div className={`flex items-center gap-1.5 font-bold uppercase tracking-wider text-[11px] mb-1.5 ${config.textCls}`}>
        <Icon size={14} />
        <span>{config.label}</span>
      </div>
      <div className="text-slate-300 leading-relaxed pl-5">
        {children}
      </div>
    </div>
  );
}
