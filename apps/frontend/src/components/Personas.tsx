import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Plus, Loader2, Trash2, Pencil, ShieldAlert, ShieldOff, Wrench } from 'lucide-react';
import PersonaEditor, { type Persona } from './PersonaEditor.js';

/**
 * The personas, and what each one is allowed to do.
 *
 * Listed with their ISOLATION visible rather than behind an edit click. A persona's egress is the
 * difference between an agent that can install a dependency and one that spends three attempts
 * discovering it cannot, and that fact belonged on the card from the start.
 */
export default function Personas({ apiBase }: { apiBase: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Persona | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: personas = [], isLoading } = useQuery<Persona[]>({
    queryKey: ['personas'],
    queryFn: () => axios.get(`${apiBase}/personas`, { withCredentials: true }).then((r) => r.data),
  });

  const remove = useMutation({
    mutationFn: (id: string) => axios.delete(`${apiBase}/personas/${id}`, { withCredentials: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personas'] }),
  });

  const nameOf = (id?: string) => personas.find((p) => p.id === id)?.name;

  return (
    <section className="p-6">
      <header className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold">Personas</h2>
          <p className="text-[13px] text-slate-400">
            Everything about how an agent runs — its prompt, its tools, its sandbox and what it can reach.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white px-4 py-2 rounded-xl flex items-center gap-2 text-[13px] font-medium"
        >
          <Plus size={16} /> New persona
        </button>
      </header>

      {isLoading ? (
        <div className="text-slate-500 flex items-center gap-2"><Loader2 className="animate-spin" size={18} /> Loading…</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {personas.map((p) => {
            const egress = p.scope?.egress ?? [];
            return (
              <div key={p.id} className="bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-2xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="font-bold truncate">{p.name}</h4>
                    {p.basedOn && <span className="text-[10px] text-slate-500">based on {nameOf(p.basedOn) ?? 'a missing persona'}</span>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => setEditing(p)} className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-[var(--bark-700)]">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => remove.mutate(p.id)} className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-[var(--bark-700)]">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {p.description && <p className="text-[12px] text-slate-400 leading-relaxed">{p.description}</p>}

                <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-slate-500 pt-2 border-t border-[var(--bark-700)]">
                  {/* Isolation on the card, because it is the thing most likely to be wrong and the
                      thing nobody thinks to check. */}
                  {egress.length === 0 ? (
                    <span className="flex items-center gap-1.5 text-amber-400/80" title="DNS only — installs and downloads will fail">
                      <ShieldAlert size={12} /> sealed
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-slate-400" title={egress.map((e) => e.namespace ?? e.cidr).join(', ')}>
                      <ShieldOff size={12} /> reaches {egress.map((e) => e.namespace ?? e.cidr).join(', ')}
                    </span>
                  )}
                  {p.scope?.language && <span>{p.scope.language}</span>}
                  {p.scope?.repo && <span>repo</span>}
                  {p.scope?.run?.maxSteps && <span>{p.scope.run.maxSteps} steps</span>}
                  {p.scope?.tools?.length ? (
                    <span className="flex items-center gap-1.5"><Wrench size={12} /> {p.scope.tools.length} tools</span>
                  ) : (
                    <span className="flex items-center gap-1.5"><Wrench size={12} /> all tools</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(editing || creating) && (
        <PersonaEditor
          apiBase={apiBase}
          {...(editing ? { persona: editing } : {})}
          personas={personas}
          onClose={() => { setEditing(null); setCreating(false); }}
        />
      )}
    </section>
  );
}
