import type { RunSummary } from './shared';

/**
 * Every execution of this experiment, so a change can be judged against what came before.
 *
 * The reason a suite is worth writing down at all: re-run it after rewording a prompt, adopting a
 * default or switching models, and the previous numbers are still there to compare against. They
 * used to be deleted to make room for the new ones, which made an experiment a question you could
 * ask exactly once.
 */
export function RunHistory({ history }: { history: RunSummary[] }) {
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  // Verified RATE, since executions can differ in how many runs completed.
  // Over fair attempts, so an execution the model server died during does not read as a regression.
  const rate = (r: RunSummary) => (r.attempted ? r.verified / r.attempted : 0);
  const delta = latest && previous ? rate(latest) - rate(previous) : 0;

  return (
    <div>
      {delta !== 0 && (
        <p className={`text-[12px] mb-2 ${delta > 0 ? 'text-[var(--leaf-light)]' : 'text-red-400'}`}>
          {`${delta > 0 ? '+' : ''}${Math.round(delta * 100)} points vs the previous run`}
        </p>
      )}
      <table className="w-full text-[11px]">
        <tbody>
          {[...history].reverse().map((h, i) => (
            <tr key={h.id} className="border-t border-[var(--bark-700)] first:border-0">
              <td className="py-1 text-slate-500">{new Date(h.startedAt).toLocaleString()}</td>
              <td className="py-1 text-slate-600 font-mono">{h.model ?? '—'}</td>
              <td className="py-1 text-right">
                <span className={h.attempted && h.verified === h.attempted ? 'text-[var(--leaf-light)]' : 'text-slate-400'}>
                  {h.verified}/{h.attempted}
                </span>
              </td>
              <td className="py-1 text-right text-slate-600">{i === 0 ? 'latest' : h.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
