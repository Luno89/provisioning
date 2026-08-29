import { ListChecks } from 'lucide-react';

export default function AcceptancePlan({
  acceptance,
}: {
  acceptance?: { name: string; command: string }[] | string | undefined;
}) {
  const checks = typeof acceptance === 'string'
    ? (acceptance.trim() ? [{ name: 'works', command: acceptance }] : [])
    : (acceptance ?? []);

  if (checks.length === 0) return null;

  return (
    <div className="mx-4 mt-3 rounded-lg border border-[var(--bark-600)] bg-[var(--bark-800)]/60 px-3 py-2">
      <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
        <ListChecks size={11} /> How we will know this is done
      </h3>
      <ol className="mt-1.5 space-y-1">
        {checks.map((c, i) => (
          <li key={`${c.name}-${i}`} className="text-[12px] text-slate-400 flex gap-2">
            <span className="text-slate-600 shrink-0">{i + 1}.</span>
            <span className="min-w-0">
              {c.name}
              <code className="ml-2 text-[11px] text-slate-500 break-all">{c.command}</code>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
