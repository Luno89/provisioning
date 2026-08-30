import { useQuery, useMutation } from '@tanstack/react-query';
import { Award } from 'lucide-react';
import { card, type HarnessProfile, type PackChange, type PromotionStanding } from './shared';
import { resetProfile, promoteVariant, previewProfile } from '../../api/harness';

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

export function PromoteConfirm({ experimentId, label, onDone, onCancel,
}: {
  experimentId: string;
  label: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  type Preview = {
    standing: PromotionStanding;
    changes: PackChange[];
    target: { id: string; name: string };
  };
  const { data, isPending } = useQuery<Preview>({
    queryKey: ['promotion-preview', experimentId, label],
    queryFn: () => previewProfile({ experimentId, label }) as Promise<Preview>,
  });

  const promote = useMutation({
    mutationFn: () => promoteVariant(experimentId, label),
    onSuccess: onDone,
  });

  if (isPending || !data) return <span className="text-[11px] text-slate-500">Checking…</span>;
  const { standing, changes, target } = data;

  return (
    <div className="bg-[var(--bark-900)]/70 border border-[var(--bark-600)] rounded-lg p-3 my-2">
      <p className="text-[11px] text-slate-400 mb-2">
        Write <span className="font-mono text-slate-200">{label}</span> into the pack{' '}
        <span className="font-mono text-slate-200">{target.name}</span>, overwriting it — verified{' '}
        {standing.verified}/{standing.attempted} across {standing.tasks} task{standing.tasks > 1 ? 's' : ''}
        {standing.broken ? (
          <span className="text-amber-400">
            {` — ${standing.broken} of ${standing.runs} run${standing.runs === 1 ? '' : 's'} never completed`}
          </span>
        ) : null}.
        {!standing.wasBest && (
          <span className="text-amber-400">
            {' '}It placed {standing.rank}, behind the best by {Math.round(standing.behindBy * 100)}
            {' '}points. Worth doing only if you are adopting it for cost or judging the suite
            unrepresentative.
          </span>
        )}
      </p>

      {changes.length === 0 ? (
        <p className="text-[11px] text-slate-500 mb-2">
          Changes nothing — this arm already matches {target.name}.
        </p>
      ) : (
        <div className="mb-2 space-y-0.5">
          {changes.map((c) => (
            <p key={c.path} className="text-[11px] font-mono">
              <span className="text-slate-400">{c.path}</span>{' '}
              <span className="text-slate-600">{c.from === undefined ? 'default' : String(c.from)}</span>
              <span className="text-slate-600"> → </span>
              <span className="text-[var(--leaf-light)]">{String(c.to)}</span>
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => promote.mutate()}
          disabled={promote.isPending || changes.length === 0}
          className="text-[12px] px-3 py-1 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-50"
        >
          Overwrite {target.name}
        </button>
        <button onClick={onCancel} className="text-[12px] text-slate-500 hover:text-slate-300">Cancel</button>
        <span className="text-[10px] text-slate-600">Applies to leaf runs too, not just experiments.</span>
      </div>
    </div>
  );
}
