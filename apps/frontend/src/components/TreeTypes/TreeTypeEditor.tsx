import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Check, AlertTriangle } from 'lucide-react';
import { updateTreeType, groveKeys } from '../../api/grove.js';
import { errorMessage } from '../../api/client.js';
import { card, blankTreeType, slugify, SLUG_PATTERN, type TreeType } from './shared.js';
import { Overview } from './Overview.js';
import { GroveAgent } from './GroveAgent.js';
import { Scaffold } from './Scaffold.js';
import { Bindings } from './Bindings.js';

export type TreeTypeSection = 'overview' | 'grown-by' | 'scaffold' | 'bindings';

function Section({ title, hint, alone, children }: { title: string; hint?: string; alone: boolean; children: ReactNode }) {
  if (alone) return <section className="py-5">{children}</section>;
  return (
    <section className="py-5 border-b border-[var(--bark-700)] last:border-0">
      <h3 className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold mb-0.5">{title}</h3>
      {hint && <p className="text-[11px] text-slate-600 mb-3">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

export function TreeTypeEditor({ type, types, only, onSaved, initialLabel }: {
  type: TreeType | undefined;
  initialLabel?: string | undefined;
  types: readonly TreeType[];
  only?: TreeTypeSection | undefined;
  onSaved?: ((saved: TreeType) => void) | undefined;
}) {
  const qc = useQueryClient();
  const isNew = type === undefined;
  const [draft, setDraft] = useState<TreeType>(() => type ?? { ...blankTreeType(), label: initialLabel ?? '', id: slugify(initialLabel ?? '') });
  const [savedNote, setSavedNote] = useState('');
  const [saveError, setSaveError] = useState('');

  const idTaken = isNew && types.some((t) => t.id === draft.id);
  const idValid = SLUG_PATTERN.test(draft.id);
  const dirty = isNew
    ? Boolean(draft.label.trim() && draft.summary.trim() && draft.doneMeans.trim())
    : JSON.stringify(draft) !== JSON.stringify(type);
  const canSave = dirty && idValid && !idTaken;
  const show = (section: TreeTypeSection) => !only || only === section;

  const save = useMutation({
    mutationFn: () => updateTreeType(draft.id, draft),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: groveKeys.treeTypes() });
      setDraft(saved);
      setSaveError('');
      setSavedNote('Saved.');
      setTimeout(() => setSavedNote(''), 2000);
      onSaved?.(saved);
    },
    onError: (err: unknown) => setSaveError(errorMessage(err)),
  });

  const patch = (p: Partial<TreeType>) => {
    if (saveError) setSaveError('');
    setDraft((d) => {
      const next = { ...d, ...p };
      if (isNew && p.label !== undefined && p.id === undefined && d.id === slugify(d.label)) {
        next.id = slugify(next.label);
      }
      return next;
    });
  };

  return (
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
        {show('overview') && (
          <Section title="Overview" alone={Boolean(only)}>
            <Overview value={draft} onChange={patch} idEditable={isNew} idError={idTaken ? 'Another type already uses this id.' : undefined} />
          </Section>
        )}
        {show('grown-by') && (
          <Section alone={Boolean(only)} title="Grown by" hint="The agent whose procedure grows a tree of this type, start to finish.">
            <GroveAgent value={draft} onChange={patch} />
          </Section>
        )}
        {show('scaffold') && (
          <Section alone={Boolean(only)} title="Scaffold" hint="Starter files rendered into a fresh repository when a tree of this type is created.">
            <Scaffold value={draft} onChange={patch} />
          </Section>
        )}
        {show('bindings') && (
          <Section alone={Boolean(only)} title="Bindings" hint="Default service bindings, extra network egress, and fixed environment variables.">
            <Bindings value={draft} onChange={patch} />
          </Section>
        )}
      </div>
    </div>
  );
}
