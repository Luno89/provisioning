import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { explainLeaf, groveKeys } from '../../api/grove.js';
import { ReadOnlyTree, recipeToDisplay, workflowToDisplay } from './ReadOnlyTree.js';

const card = 'bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-xl p-4';
const label = 'text-[10px] uppercase tracking-widest text-slate-500 mb-2 block';

const ROLE_LABELS = { planner: 'Planner', judge: 'Judge', merger: 'Merger' } as const;

export function LeafTransparency({ leafId }: { leafId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: groveKeys.explain(leafId),
    queryFn: () => explainLeaf(leafId),
  });
  const [which, setWhich] = useState<'onSuccess' | 'onFailure'>('onSuccess');

  if (isLoading) return <p className="text-[12px] text-slate-500">Loading…</p>;
  if (isError || !data) return <p className="text-[12px] text-red-400">Could not load what would happen for this leaf.</p>;

  const { treeType, roles, validationRecipe, leafWorkflow, autoAccept } = data;

  return (
    <div className="space-y-4">
      <div className={card}>
        <label className={label}>Tree type</label>
        {treeType ? (
          <>
            <p className="text-[13px] text-slate-200 font-medium">{treeType.label}</p>
            <p className="text-[12px] text-slate-500 mt-0.5">{treeType.summary}</p>
          </>
        ) : (
          <p className="text-[12px] text-slate-500 italic">This leaf's tree type could not be resolved.</p>
        )}
      </div>

      <div className={card}>
        <label className={label}>Roles</label>
        <div className="grid grid-cols-3 gap-3">
          {(Object.keys(ROLE_LABELS) as (keyof typeof ROLE_LABELS)[]).map((role) => (
            <div key={role}>
              <p className="text-[10px] text-slate-500">{ROLE_LABELS[role]}</p>
              <p className="text-[13px] text-slate-200">{roles[role]?.name ?? <span className="text-slate-600 italic">none assigned</span>}</p>
            </div>
          ))}
        </div>
      </div>

      <div className={card}>
        <label className={label}>Auto-accept</label>
        <div className="flex items-start gap-2">
          {autoAccept.verdict.accept
            ? <CheckCircle2 size={15} className="text-emerald-400 shrink-0 mt-0.5" />
            : <XCircle size={15} className="text-slate-500 shrink-0 mt-0.5" />}
          <div>
            <p className="text-[13px] text-slate-200">
              {autoAccept.verdict.accept ? 'Would auto-accept' : 'Would not auto-accept'}
            </p>
            <p className="text-[12px] text-slate-500">{autoAccept.verdict.reason}</p>
          </div>
        </div>
        {autoAccept.policy.enabled && (
          <p className="text-[11px] text-slate-600 mt-2">
            title ≥ {autoAccept.policy.minTitleChars} chars, body ≥ {autoAccept.policy.minBodyChars} chars,
            {autoAccept.policy.requirePersona ? ' a persona assigned,' : ''} up to {autoAccept.policy.max} at once
          </p>
        )}
      </div>

      <div className={card}>
        <label className={label}>Validation recipe</label>
        <ReadOnlyTree nodes={recipeToDisplay(validationRecipe?.checks ?? [])} />
      </div>

      <div className={card}>
        <label className={label}>Leaf workflow</label>
        <div className="flex gap-1 mb-3">
          <button
            type="button"
            onClick={() => setWhich('onSuccess')}
            className={`text-[11px] px-2.5 py-1 rounded-lg cursor-pointer transition-colors ${
              which === 'onSuccess' ? 'bg-[var(--leaf-stem)] text-white' : 'text-slate-400 hover:bg-[var(--bark-700)]'
            }`}
          >
            On success
          </button>
          <button
            type="button"
            onClick={() => setWhich('onFailure')}
            className={`text-[11px] px-2.5 py-1 rounded-lg cursor-pointer transition-colors ${
              which === 'onFailure' ? 'bg-[var(--leaf-stem)] text-white' : 'text-slate-400 hover:bg-[var(--bark-700)]'
            }`}
          >
            On failure
          </button>
        </div>
        <ReadOnlyTree nodes={workflowToDisplay(leafWorkflow[which])} />
      </div>
    </div>
  );
}

export default LeafTransparency;
