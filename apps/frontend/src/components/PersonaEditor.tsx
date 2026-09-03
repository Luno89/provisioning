import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Loader2 } from 'lucide-react';
import { updatePersona, createPersona } from '../api/personas';
import { errorMessage } from '../api/client';

export interface Persona {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  basedOn?: string;
}

const label = 'text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1 block';
const field = 'w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-lg px-3 py-2 text-[13px] text-slate-200';

export default function PersonaEditor({
  persona, personas, onClose,
}: {
  persona?: Persona | undefined;
  personas: Persona[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Persona>(() => persona ?? { id: '', name: '' });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: draft.name,
        description: draft.description ?? '',
        systemPrompt: draft.systemPrompt ?? '',
        basedOn: draft.basedOn ?? '',
      };
      return persona ? updatePersona(persona.id, body) : createPersona(body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['personas'] }); onClose(); },
    onError: (err: unknown) => setError(errorMessage(err) || 'Could not save.'),
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-6 z-50" onClick={onClose}>
      <div
        className="bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-2xl w-full max-w-3xl max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-[var(--bark-700)] flex items-center justify-between">
          <h3 className="font-bold text-lg">{persona ? `Edit ${persona.name}` : 'New persona'}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-[var(--bark-700)]">
            <X size={17} />
          </button>
        </div>

        <div className="overflow-y-auto p-5 space-y-5">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <span className={label}>Name</span>
              <input className={field} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div>
              <span className={label}>Based on</span>
              <select
                className={field}
                value={draft.basedOn ?? ''}
                onChange={(e) => setDraft({ ...draft, basedOn: e.target.value })}
              >
                <option value="">nothing — this one stands alone</option>
                {personas.filter((p) => p.id !== persona?.id).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <span className={label}>Description</span>
            <input
              className={field}
              value={draft.description ?? ''}
              placeholder="One line, shown in the picker"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>

          <div>
            <span className={label}>System prompt</span>
            <textarea
              className={`${field} font-mono min-h-[140px]`}
              value={draft.systemPrompt ?? ''}
              onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
            />
          </div>

          {error && <p className="text-[12px] text-red-400">{error}</p>}
        </div>

        <div className="p-5 border-t border-[var(--bark-700)] flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-[13px] text-slate-400 hover:text-slate-200">Cancel</button>
          <button
            onClick={() => { setError(null); save.mutate(); }}
            disabled={save.isPending || !draft.name.trim()}
            className="px-4 py-2 rounded-lg text-[13px] bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-50 flex items-center gap-2"
          >
            {save.isPending && <Loader2 size={13} className="animate-spin" />}
            {persona ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
