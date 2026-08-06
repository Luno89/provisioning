import { useQuery, useMutation } from '@tanstack/react-query';
import axios from 'axios';
import { Award } from 'lucide-react';
import { card, type HarnessProfile, type OverrideChange, type PromotionStanding } from './shared';

export function ProfileBanner({
  apiBase, profile, onChanged,
}: {
  apiBase: string;
  profile: HarnessProfile | null;
  onChanged: () => void;
}) {
  const reset = useMutation({
    mutationFn: () => axios.delete(`${apiBase}/harness/profile`, { withCredentials: true }),
    onSuccess: onChanged,
  });

  if (!profile?.overrides || !Object.keys(profile.overrides).length) return null;
  const from = profile.from;

  return (
    <div className={`${card} p-4 mb-6 border-[var(--leaf-stem)]/50`}>
      <div className="flex items-start gap-3">
        <Award size={16} className="text-[var(--leaf-light)] mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-slate-200 mb-1">Adopted defaults</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2">
            {Object.entries(profile.overrides).map(([key, value]) => (
              <code key={key} className="text-[11px] text-[var(--leaf-light)]">
                {key}={String(value)}
              </code>
            ))}
          </div>
          {from ? (
            <p className="text-[11px] text-slate-500">
              From <span className="text-slate-400">{from.experimentName}</span> ·{' '}
              <span className="font-mono">{from.variantLabel}</span> · verified {from.verified}/{from.runs}{' '}
              across {from.tasks} task{from.tasks > 1 ? 's' : ''}
              {/* Stated plainly, because adopting a variant that lost is allowed and must not be
                  something you discover later by reading the record. */}
              {!from.wasBest && (
                <span className="text-amber-400"> · did not win its experiment</span>
              )}
            </p>
          ) : (
            <p className="text-[11px] text-slate-500">Set by hand — no experiment backs these.</p>
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

/**
 * Confirming a promotion, with the standing and the diff.
 *
 * "Promote" on a variant labelled `think=true` sounds like it changes one thing, and once a profile
 * has accumulated a few promotions it rarely does — so what would actually change is fetched from
 * the server and shown before anything is applied.
 */
export function PromoteConfirm({
  apiBase, experimentId, label, onDone, onCancel,
}: {
  apiBase: string;
  experimentId: string;
  label: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { data, isPending } = useQuery<{ standing: PromotionStanding; changes: OverrideChange[] }>({
    queryKey: ['promotion-preview', experimentId, label],
    queryFn: () => axios
      .get(`${apiBase}/harness/profile/preview`, {
        params: { experimentId, label }, withCredentials: true,
      })
      .then((r) => r.data),
  });

  const promote = useMutation({
    mutationFn: () => axios.post(
      `${apiBase}/harness/profile/promote`, { experimentId, label }, { withCredentials: true },
    ),
    onSuccess: onDone,
  });

  if (isPending || !data) return <span className="text-[11px] text-slate-500">Checking…</span>;
  const { standing, changes } = data;

  return (
    <div className="bg-[var(--bark-900)]/70 border border-[var(--bark-600)] rounded-lg p-3 my-2">
      <p className="text-[11px] text-slate-400 mb-2">
        Adopt <span className="font-mono text-slate-200">{label}</span> as the default — verified{' '}
        {standing.verified}/{standing.runs} across {standing.tasks} task{standing.tasks > 1 ? 's' : ''}.
        {!standing.wasBest && (
          <span className="text-amber-400">
            {' '}It placed {standing.rank}, behind the best by {Math.round(standing.behindBy * 100)}
            {' '}points. Worth doing only if you are adopting it for cost or judging the suite
            unrepresentative.
          </span>
        )}
      </p>

      {changes.length === 0 ? (
        <p className="text-[11px] text-slate-500 mb-2">Changes nothing — it already matches the defaults.</p>
      ) : (
        <div className="mb-2 space-y-0.5">
          {changes.map((c) => (
            <p key={c.key} className="text-[11px] font-mono">
              <span className="text-slate-400">{c.label}</span>{' '}
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
          Adopt
        </button>
        <button onClick={onCancel} className="text-[12px] text-slate-500 hover:text-slate-300">Cancel</button>
        <span className="text-[10px] text-slate-600">Applies to leaf runs too, not just experiments.</span>
      </div>
    </div>
  );
}
