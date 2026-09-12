import { Sprout, AlertTriangle, Check, X } from 'lucide-react';
import type { ProposedLeaf } from './hooks/useBranchTurn.js';

export interface SproutingLeavesCardProps {
  proposed: ProposedLeaf[];
  onAccept?: ((id: string) => void) | undefined;
  onReject?: ((id: string) => void) | undefined;
  onAcceptAll?: (() => void) | undefined;
}

export function SproutingLeavesCard({
  proposed,
  onAccept,
  onReject,
  onAcceptAll,
}: SproutingLeavesCardProps) {
  if (proposed.length === 0) return null;

  return (
    <div className="mt-3 shrink-0 rounded-xl border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/10 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Sprout size={13} className="text-[var(--leaf-light)]" />
        <h3 className="text-[11px] uppercase tracking-widest text-[var(--leaf-light)] flex-1">
          {proposed.length} sprouting
        </h3>
        {proposed.length > 1 && onAcceptAll && (
          <button
            type="button"
            onClick={onAcceptAll}
            disabled={proposed.some((p) => !p.packId)}
            title={proposed.some((p) => !p.packId) ? 'Some of these have nobody assigned' : undefined}
            className="text-[11px] px-2 py-1 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] disabled:opacity-40 text-white cursor-pointer"
          >
            Accept all
          </button>
        )}
      </div>
      <ul className="space-y-1.5 max-h-52 overflow-y-auto">
        {proposed.map((p) => (
          <li key={p.id} className="flex items-start gap-2 rounded-lg bg-[var(--bark-800)] px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-slate-200">{p.title}</p>
              {p.body && <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed line-clamp-2">{p.body}</p>}
              {!p.packId && (
                <p className="text-[11px] text-amber-400/90 mt-1 flex items-center gap-1">
                  <AlertTriangle size={11} /> needs a persona before it can run
                </p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => onAccept?.(p.id)}
                disabled={!p.packId}
                title={p.packId ? 'Accept — starts the work' : 'Assign a persona first'}
                className="p-1 rounded-md text-[var(--leaf-light)] hover:bg-[var(--bark-700)] disabled:opacity-30 cursor-pointer"
              >
                <Check size={14} />
              </button>
              <button
                type="button"
                onClick={() => onReject?.(p.id)}
                title="Reject"
                className="p-1 rounded-md text-slate-500 hover:text-red-400 hover:bg-[var(--bark-700)] cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
