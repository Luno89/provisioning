import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { card } from '../lib/pack-editor.js';
import { ago } from './home-summary.js';
import { getRateLimits, rateLimitKeys, type ModelRateLimitBucketSnapshot } from '../api/harness';

function cooldownLabel(iso: string): string {
  const remaining = Math.round((Date.parse(iso) - Date.now()) / 1000);
  return remaining > 0 ? `cools down in ${remaining}s` : 'cooling down';
}

export function ModelRateLimits() {
  const { data: buckets = [] } = useQuery<ModelRateLimitBucketSnapshot[]>({
    queryKey: rateLimitKeys.list(),
    queryFn: getRateLimits,
    refetchInterval: 5000,
  });

  if (buckets.length === 0) return null;

  return (
    <section>
      <h3 className="text-[10px] uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
        <Gauge size={12} /> Model rate limits
      </h3>
      <div className={`${card} p-4 overflow-x-auto`}>
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-slate-500 text-left">
              <th className="pb-2 pr-3 font-medium">Endpoint</th>
              <th className="pb-2 pr-3 font-medium">In flight</th>
              <th className="pb-2 pr-3 font-medium">Queued</th>
              <th className="pb-2 pr-3 font-medium">Status</th>
              <th className="pb-2 pr-3 font-medium">Requests</th>
              <th className="pb-2 pr-3 font-medium">429s</th>
              <th className="pb-2 pr-3 font-medium">Errors</th>
              <th className="pb-2 font-medium">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.key} className="border-t border-[var(--bark-700)] first:border-0">
                <td className="py-1.5 pr-3 text-slate-200 font-mono">{b.label}</td>
                <td className="py-1.5 pr-3 text-slate-300">{b.inFlight}</td>
                <td className="py-1.5 pr-3 text-slate-300">{b.queued}</td>
                <td className="py-1.5 pr-3">
                  {b.cooldownUntil ? (
                    <span className="text-amber-400">{cooldownLabel(b.cooldownUntil)}</span>
                  ) : (
                    <span className="text-emerald-400">clear</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-slate-400">{b.totalRequests}</td>
                <td className="py-1.5 pr-3 text-slate-400">{b.total429}</td>
                <td className="py-1.5 pr-3 text-slate-400">{b.totalErrors}</td>
                <td className="py-1.5 text-slate-500">{b.lastRequestAt ? ago(b.lastRequestAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default ModelRateLimits;
