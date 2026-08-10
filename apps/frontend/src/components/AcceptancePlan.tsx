import { ListChecks } from 'lucide-react';

/**
 * The checks that decide whether a request delivered, shown where the work is accepted.
 *
 * ── WHY THIS COMPONENT EXISTS ──
 * The planner writes these itself, which is only safe because a person reads them before agreeing
 * to the work: a check of `echo ok` proves nothing, and the defence against it is that it is sitting
 * in front of you, not that the model would never write it.
 *
 * That defence was stated twice while the field appeared nowhere in the interface. It was recorded,
 * it ran, its verdict was posted to the conversation — and the one moment it needed to be visible,
 * before accepting, it was not.
 */
export default function AcceptancePlan({
  acceptance,
}: {
  acceptance?: { name: string; command: string }[] | string | undefined;
}) {
  // The older single-command form, still stored on branches created before the plan existed.
  const checks = typeof acceptance === 'string'
    ? (acceptance.trim() ? [{ name: 'works', command: acceptance }] : [])
    : (acceptance ?? []);

  /**
   * Silence when nothing is declared, rather than a reassuring empty panel.
   *
   * The plan review already says "nothing will run the finished result" in the conversation, which
   * is the place a warning belongs. A second empty box here would read as "checks: none required".
   */
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
              {/* The command is the part worth scrutinising, so it is shown rather than hidden
                  behind the friendly name the model chose for it. */}
              <code className="ml-2 text-[11px] text-slate-500 break-all">{c.command}</code>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
