import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GitBranch, Save, Check, AlertTriangle, Plus } from 'lucide-react';
import { listTreeTypes, updateTreeType, groveKeys } from '../../api/grove.js';
import { listCustomSteps, customStepKeys } from '../../api/custom-steps.js';
import { errorMessage } from '../../api/client.js';
import { card, blankTreeType, slugify, SLUG_PATTERN, type TreeType, type CustomStepDefinition } from './shared.js';
import { Overview } from './Overview.js';
import { Scaffold } from './Scaffold.js';
import { RecipePanel } from './Recipe/index.js';
import { Bindings } from './Bindings.js';
import { Roles } from './Roles.js';
import { AutoAccept } from './AutoAccept.js';
import { CustomSteps } from './CustomSteps.js';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="py-5 border-b border-[var(--bark-700)] last:border-0">
      <h3 className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold mb-0.5">{title}</h3>
      {hint && <p className="text-[11px] text-slate-600 mb-3">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

export function TreeTypes() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TreeType | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [savedNote, setSavedNote] = useState('');
  const [saveError, setSaveError] = useState('');

  const { data: types = [], isLoading } = useQuery<TreeType[]>({
    queryKey: groveKeys.treeTypes(),
    queryFn: listTreeTypes,
  });

  const { data: customSteps = [] } = useQuery<CustomStepDefinition[]>({
    queryKey: customStepKeys.list(),
    queryFn: listCustomSteps,
  });

  const selected = types.find((t) => t.id === selectedId) ?? null;

  // Reset the draft whenever a different tree type is selected, or the underlying record changes
  // out from under an unmodified draft (e.g. after this component's own save). Not while creating a
  // new one — there's no persisted record for that draft to resync against yet.
  useEffect(() => {
    if (!isNew && selected && (!draft || draft.id !== selected.id)) setDraft(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, isNew]);

  const idTaken = isNew && draft ? types.some((t) => t.id === draft.id) : false;
  const idValid = draft ? SLUG_PATTERN.test(draft.id) : false;

  const dirty = isNew
    ? Boolean(draft?.label.trim() && draft.summary.trim() && draft.doneMeans.trim())
    : Boolean(draft && selected && JSON.stringify(draft) !== JSON.stringify(selected));
  const canSave = dirty && idValid && !idTaken;

  const save = useMutation({
    mutationFn: () => updateTreeType(draft!.id, draft!),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: groveKeys.treeTypes() });
      setDraft(saved);
      setIsNew(false);
      setSelectedId(saved.id);
      setSaveError('');
      setSavedNote('Saved.');
      setTimeout(() => setSavedNote(''), 2000);
    },
    onError: (err: unknown) => setSaveError(errorMessage(err)),
  });

  const patch = (p: Partial<TreeType>) => {
    if (saveError) setSaveError('');
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, ...p };
      // While the id hasn't diverged from what the label alone would produce, keep deriving it —
      // once the user edits the id field directly (or types.some already claims the derived slug),
      // this stops so their own choice sticks.
      if (isNew && p.label !== undefined && p.id === undefined && d.id === slugify(d.label)) {
        next.id = slugify(next.label);
      }
      return next;
    });
  };

  const startNew = () => {
    setIsNew(true);
    setSelectedId(null);
    setDraft(blankTreeType());
    setSaveError('');
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3 mb-1">
        <GitBranch className="text-[var(--leaf-light)]" size={26} />
        <h2 className="text-3xl font-bold">Tree Types</h2>
      </div>
      <p className="text-slate-500 text-sm -mt-4">
        What a Grove project of a given type starts from, what proves a leaf is done, and which pack
        runs each role — all editable per type, not just seed data.
      </p>

      <CustomSteps />

      <div className="flex gap-6 items-start">
        <div className="w-64 shrink-0 space-y-1">
          <button
            type="button"
            onClick={startNew}
            className="w-full flex items-center gap-1.5 justify-center text-[12px] px-3 py-2 mb-1 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white cursor-pointer"
          >
            <Plus size={13} /> New tree type
          </button>

          {isLoading && <p className="text-[12px] text-slate-500">Loading…</p>}
          {types.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { setIsNew(false); setSelectedId(t.id); }}
              className={`w-full text-left px-3 py-2 rounded-lg text-[12px] transition-colors cursor-pointer ${
                !isNew && t.id === selectedId
                  ? 'bg-emerald-950/60 text-emerald-300 font-medium border border-emerald-500/30'
                  : 'text-slate-300 hover:bg-[var(--bark-700)] border border-transparent'
              }`}
            >
              <div className="font-semibold truncate">{t.label}</div>
              <div className="text-slate-500 truncate">{t.summary}</div>
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-0">
          {!draft ? (
            <div className={`${card} p-8 text-center text-[13px] text-slate-500`}>
              Pick a tree type on the left to edit it, or create a new one.
            </div>
          ) : (
            <div className={`${card} overflow-hidden`}>
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--bark-700)] bg-[var(--bark-800)] px-4 py-2.5">
                <span className="font-semibold text-slate-200 truncate">{draft.label || (isNew ? 'New tree type' : draft.id)}</span>
                <div className="flex-1" />
                {saveError && (
                  <span className="text-[11px] text-red-400 flex items-center gap-1 max-w-xs truncate" title={saveError}>
                    <AlertTriangle size={12} /> {saveError}
                  </span>
                )}
                {!saveError && savedNote && (
                  <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                    <Check size={12} /> {savedNote}
                  </span>
                )}
                <button
                  type="button"
                  disabled={!canSave || save.isPending}
                  onClick={() => save.mutate()}
                  className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 text-white cursor-pointer disabled:cursor-not-allowed"
                >
                  <Save size={13} /> {save.isPending ? 'Saving…' : isNew ? 'Create' : 'Save'}
                </button>
              </div>

              <div className="px-4">
                <Section title="Overview">
                  <Overview
                    value={draft}
                    onChange={patch}
                    idEditable={isNew}
                    idError={idTaken ? 'Another type already uses this id.' : undefined}
                  />
                </Section>

                <Section title="Scaffold" hint="Starter files rendered into a fresh repository when a tree of this type is created.">
                  <Scaffold value={draft} onChange={patch} />
                </Section>

                <Section title="Validation recipe" hint="What proves a leaf of this type is actually done, as an ordered pipeline of checks.">
                  <RecipePanel
                    recipe={draft.validationRecipe}
                    customSteps={customSteps}
                    onChange={(validationRecipe) => patch({ validationRecipe })}
                  />
                </Section>

                <Section title="Bindings" hint="Default service bindings, extra network egress, and fixed environment variables.">
                  <Bindings value={draft} onChange={patch} />
                </Section>

                <Section title="Roles" hint="Which pack fills the planner/judge/merger role for a project of this type.">
                  <Roles value={draft} onChange={patch} />
                </Section>

                <Section title="Auto-accept" hint="How readily a proposed leaf on this type auto-accepts without a human clicking accept.">
                  <AutoAccept value={draft} onChange={patch} />
                </Section>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default TreeTypes;
