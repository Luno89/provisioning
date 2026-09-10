import { field, label, type TreeType } from './shared.js';

const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

export function AutoAccept({ value, onChange }: {
  value: TreeType;
  onChange: (patch: Partial<TreeType>) => void;
}) {
  const auto = value.autoAccept ?? {};
  const patchAuto = (p: Partial<NonNullable<TreeType['autoAccept']>>) => onChange({ autoAccept: { ...auto, ...p } });

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-slate-500 leading-relaxed">
        How readily a proposed leaf on a project of this type auto-accepts, without a human clicking accept.
      </p>

      <label className="flex items-center gap-2 text-[12px] text-slate-300">
        <input type="checkbox" checked={auto.enabled ?? false} onChange={(e) => patchAuto({ enabled: e.target.checked })} />
        Enable auto-accept for this type
      </label>

      <label className="flex items-center gap-2 text-[12px] text-slate-300">
        <input type="checkbox" checked={auto.requirePersona ?? true} onChange={(e) => patchAuto({ requirePersona: e.target.checked })} />
        Require a persona to be assigned before auto-accepting
      </label>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={label}>Max leaves per batch</label>
          <input className={field} type="number" min={0} value={auto.max ?? ''} onChange={(e) => patchAuto({ max: num(e.target.value) })} />
        </div>
        <div>
          <label className={label}>Min title chars</label>
          <input className={field} type="number" min={0} value={auto.minTitleChars ?? ''} onChange={(e) => patchAuto({ minTitleChars: num(e.target.value) })} />
        </div>
        <div>
          <label className={label}>Min body chars</label>
          <input className={field} type="number" min={0} value={auto.minBodyChars ?? ''} onChange={(e) => patchAuto({ minBodyChars: num(e.target.value) })} />
        </div>
      </div>
    </div>
  );
}

export default AutoAccept;
