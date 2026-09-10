import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus, Trash2, Wand2 } from 'lucide-react';
import { listCustomSteps, createCustomStep, updateCustomStep, deleteCustomStep, customStepKeys } from '../../api/custom-steps.js';
import { errorMessage } from '../../api/client.js';
import { card, field, label, SLUG_PATTERN, type CustomStepDefinition, type CustomStepField, type CustomStepFieldKind } from './shared.js';

const FIELD_KINDS: CustomStepFieldKind[] = ['string', 'number', 'boolean'];

const blankField = (): CustomStepField => ({ key: '', label: '', kind: 'string' });

const blankDefinition = (): CustomStepDefinition => ({
  id: '', name: '', fields: [], command: '',
});

export function CustomSteps() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CustomStepDefinition | null>(null);
  const [error, setError] = useState('');

  const { data: definitions = [] } = useQuery<CustomStepDefinition[]>({
    queryKey: customStepKeys.list(),
    queryFn: listCustomSteps,
    enabled: open,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: customStepKeys.list() });

  const save = useMutation({
    mutationFn: (d: CustomStepDefinition) => (definitions.some((x) => x.id === d.id) ? updateCustomStep(d.id, d) : createCustomStep(d)),
    onSuccess: () => { invalidate(); setEditingId(null); setDraft(null); setError(''); },
    onError: (err: unknown) => setError(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteCustomStep(id),
    onSuccess: invalidate,
    onError: (err: unknown) => setError(errorMessage(err)),
  });

  const startNew = () => { setEditingId('__new__'); setDraft(blankDefinition()); setError(''); };
  const startEdit = (d: CustomStepDefinition) => { setEditingId(d.id); setDraft(d); setError(''); };
  const cancel = () => { setEditingId(null); setDraft(null); setError(''); };

  const patchDraft = (p: Partial<CustomStepDefinition>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const patchField = (i: number, p: Partial<CustomStepField>) =>
    setDraft((d) => (d ? { ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) } : d));

  const idValid = draft ? SLUG_PATTERN.test(draft.id) : false;

  return (
    <div className={card}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-4 py-3 text-left cursor-pointer">
        {open ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
        <Wand2 size={14} className="text-[var(--leaf-light)]" />
        <span className="font-semibold text-slate-200">Custom step types</span>
        <span className="text-[12px] text-slate-500">Reusable validation step kinds, shared across every tree type</span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-[var(--bark-700)] pt-3 space-y-2">
          {definitions.map((d) => (
            <div key={d.id} className="bg-[var(--bark-900)]/60 border border-[var(--bark-600)] rounded-lg">
              <div className="flex items-center gap-2 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-slate-200">{d.name}</span>
                  <span className="text-[11px] text-slate-500 ml-2 font-mono">{d.id}</span>
                  {d.description && <p className="text-[11px] text-slate-500">{d.description}</p>}
                </div>
                <button type="button" onClick={() => startEdit(d)} className="text-[11px] text-[var(--leaf-light)] hover:text-white cursor-pointer">Edit</button>
                <button type="button" title="Delete" onClick={() => remove.mutate(d.id)} className="p-1 text-slate-500 hover:text-red-400 cursor-pointer"><Trash2 size={13} /></button>
              </div>
              {editingId === d.id && draft && (
                <DefinitionEditor
                  draft={draft} idFixed idValid={true} onPatch={patchDraft} onPatchField={patchField}
                  onAddField={() => patchDraft({ fields: [...draft.fields, blankField()] })}
                  onRemoveField={(i) => patchDraft({ fields: draft.fields.filter((_, j) => j !== i) })}
                  onCancel={cancel} onSave={() => save.mutate(draft)} saving={save.isPending} error={error}
                />
              )}
            </div>
          ))}

          {definitions.length === 0 && editingId !== '__new__' && (
            <p className="text-[12px] text-slate-500 italic">No custom step types yet.</p>
          )}

          {editingId === '__new__' && draft ? (
            <div className="bg-[var(--bark-900)]/60 border border-[var(--bark-600)] rounded-lg">
              <DefinitionEditor
                draft={draft} idValid={idValid} onPatch={patchDraft} onPatchField={patchField}
                onAddField={() => patchDraft({ fields: [...draft.fields, blankField()] })}
                onRemoveField={(i) => patchDraft({ fields: draft.fields.filter((_, j) => j !== i) })}
                onCancel={cancel} onSave={() => save.mutate(draft)} saving={save.isPending} error={error}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={startNew}
              className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white cursor-pointer"
            >
              <Plus size={13} /> New custom step type
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DefinitionEditor({
  draft, idFixed, idValid, onPatch, onPatchField, onAddField, onRemoveField, onCancel, onSave, saving, error,
}: {
  draft: CustomStepDefinition;
  idFixed?: boolean;
  idValid: boolean;
  onPatch: (p: Partial<CustomStepDefinition>) => void;
  onPatchField: (i: number, p: Partial<CustomStepField>) => void;
  onAddField: () => void;
  onRemoveField: (i: number) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  error: string;
}) {
  return (
    <div className="px-3 pb-3 border-t border-[var(--bark-700)] pt-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Id (slug)</label>
          <input
            className={field} value={draft.id} disabled={idFixed}
            onChange={(e) => onPatch({ id: e.target.value })}
            placeholder="lighthouse-check"
          />
          {!idFixed && draft.id && !idValid && <p className="text-[11px] text-red-400 mt-1">Not a valid slug.</p>}
        </div>
        <div>
          <label className={label}>Name</label>
          <input className={field} value={draft.name} onChange={(e) => onPatch({ name: e.target.value })} placeholder="Lighthouse score check" />
        </div>
      </div>

      <div>
        <label className={label}>Description (optional)</label>
        <input className={field} value={draft.description ?? ''} onChange={(e) => onPatch({ description: e.target.value || undefined })} placeholder="What this step checks" />
      </div>

      <div>
        <label className={label}>Command template</label>
        <input
          className={`${field} font-mono`} value={draft.command}
          onChange={(e) => onPatch({ command: e.target.value })}
          placeholder="lighthouse {{url}} --min-score={{minScore}}"
        />
        <p className="text-[11px] text-slate-500 mt-1">
          A shell command. <code>{'{{fieldKey}}'}</code> is replaced with that field's value on each step instance.
        </p>
      </div>

      <div>
        <label className={label}>Fields (shown as inputs when someone adds this step)</label>
        <div className="space-y-2">
          {draft.fields.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={`${field} font-mono`} placeholder="key" value={f.key} onChange={(e) => onPatchField(i, { key: e.target.value })} />
              <input className={field} placeholder="Label" value={f.label} onChange={(e) => onPatchField(i, { label: e.target.value })} />
              <select className={`${field} w-auto`} value={f.kind} onChange={(e) => onPatchField(i, { kind: e.target.value as CustomStepFieldKind })}>
                {FIELD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <button type="button" onClick={() => onRemoveField(i)} className="p-1 text-slate-500 hover:text-red-400 cursor-pointer"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={onAddField}
          className="mt-2 flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-lg border border-[var(--bark-600)] text-slate-300 hover:bg-[var(--bark-700)] cursor-pointer"
        >
          <Plus size={12} /> Add field
        </button>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          disabled={saving || !draft.name.trim() || !draft.command.trim() || !idValid}
          onClick={onSave}
          className="text-[12px] px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 text-white cursor-pointer disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="text-[12px] px-3 py-1.5 rounded-lg border border-[var(--bark-600)] text-slate-300 hover:bg-[var(--bark-700)] cursor-pointer">
          Cancel
        </button>
        {error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
    </div>
  );
}

export default CustomSteps;
