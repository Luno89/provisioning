import type { RunSummary } from './shared';

export function RunHistory({ history }: { history: RunSummary[] }) {
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
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
