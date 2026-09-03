import { useMutation } from '@tanstack/react-query';
import { Award } from 'lucide-react';
import { card } from '../lib/pack-editor.js';
import type { HarnessProfile } from '@koala/harness-types';
import { resetProfile } from '../api/harness';

export function ProfileBanner({ profile, onChanged,
}: {
  profile: HarnessProfile | null;
  onChanged: () => void;
}) {
  const reset = useMutation({
    mutationFn: () => resetProfile(),
    onSuccess: onChanged,
  });

  if (!profile?.packId) return null;
  const from = profile.from;

  return (
    <div className={`${card} p-4 mb-6 border-[var(--leaf-stem)]/50`}>
      <div className="flex items-start gap-3">
        <Award size={16} className="text-[var(--leaf-light)] mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-slate-200 mb-1">Running as</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2">
            <code className="text-[11px] text-[var(--leaf-light)]">{profile.packId}</code>
          </div>
          {from ? (
            <p className="text-[11px] text-slate-500">
              From <span className="text-slate-400">{from.experimentName}</span> ·{' '}
              <span className="font-mono">{from.variantLabel}</span> · verified {from.verified}/{from.runs}{' '}
              across {from.tasks} task{from.tasks > 1 ? 's' : ''}
              {!from.wasBest && (
                <span className="text-amber-400"> · did not win its experiment</span>
              )}
            </p>
          ) : (
            <p className="text-[11px] text-slate-500">Chosen by hand — no experiment backs it.</p>
          )}
        </div>
        <button
          onClick={() => reset.mutate()}
          className="text-[11px] text-slate-500 hover:text-red-400 shrink-0"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

export default ProfileBanner;
