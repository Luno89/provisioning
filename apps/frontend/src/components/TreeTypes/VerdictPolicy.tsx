import { field, label, type TreeType } from './shared.js';

export function VerdictPolicyPanel({ value, onChange }: {
  value: TreeType;
  onChange: (patch: Partial<TreeType>) => void;
}) {
  const policy = value.verdictPolicy ?? {};
  const patch = (p: Partial<NonNullable<TreeType['verdictPolicy']>>) => onChange({ verdictPolicy: { ...policy, ...p } });

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-slate-500 leading-relaxed">
        How a single leaf run's tests and declared artifacts combine into succeeded or failed.
      </p>

      <label className="flex items-center gap-2 text-[12px] text-slate-300">
        <input type="checkbox" checked={policy.requireVerify ?? false} onChange={(e) => patch({ requireVerify: e.target.checked })} />
        Require real evidence — an unverified run fails instead of trusting the agent's own claim
      </label>

      <label className="flex items-center gap-2 text-[12px] text-slate-300">
        <input type="checkbox" checked={policy.requireArtifacts ?? false} onChange={(e) => patch({ requireArtifacts: e.target.checked })} />
        Require declared artifacts — a leaf that names none, or whose check could not run, fails
      </label>

      <div>
        <label className={label}>Combine tests and artifacts</label>
        <select
          className={field}
          value={policy.combineMode ?? 'any'}
          onChange={(e) => patch({ combineMode: e.target.value as 'all' | 'any' })}
        >
          <option value="any">Either passing is enough</option>
          <option value="all">Both must independently pass</option>
        </select>
      </div>
    </div>
  );
}

export default VerdictPolicyPanel;
