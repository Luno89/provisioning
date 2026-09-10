import { useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Loader2, Trash2, Pencil, Sliders, CornerDownRight } from 'lucide-react';
import PersonaEditor, { type Persona } from './PersonaEditor.js';
import PersonaConfigDrawer from './PersonaConfigDrawer.js';
import { statsFor, byLineage, type PersonaStats } from './persona-stats.js';
import type { Leaf } from './leaf-types.js';
import { listPersonas, deletePersona, personaKeys } from '../api/personas';
import { listLeaves, groveKeys } from '../api/grove';
import { listPacks, packKeys } from '../api/packs';

function Rate({ stats }: { stats: PersonaStats }) {
  if (stats.verifiedRate === undefined) {
    return <span className="text-slate-600">—</span>;
  }
  const pct = Math.round(stats.verifiedRate * 100);
  const confident = stats.finished >= 5;
  const tone = !confident ? 'text-slate-400' : pct >= 80 ? 'text-green-400' : pct >= 50 ? 'text-amber-400' : 'text-red-400';
  return (
    <span className={tone} title={`${stats.verified} of ${stats.finished} finished leaves were checked${confident ? '' : ' — too few runs to read much into'}`}>
      {pct}%{!confident && <span className="text-slate-600 ml-1">?</span>}
    </span>
  );
}

const tokens = (n: number) => (n === 0 ? '—' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export default function Personas() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Persona | null>(null);
  const [creating, setCreating] = useState(false);
  const [configuringPackId, setConfiguringPackId] = useState<string | null>(null);

  const { data: personas = [], isLoading } = useQuery<Persona[]>({
    queryKey: personaKeys.list(),
    queryFn: listPersonas,
  });
  const { data: leaves = [] } = useQuery<Leaf[]>({
    queryKey: groveKeys.leaves(),
    queryFn: listLeaves,
    staleTime: 30_000,
  });
  // Leaves are assigned to packs, not personas directly — stats need the pack a persona is bound
  // to, which was the bug: this used to filter leaves by leaf.personaId, a field nothing writes.
  const { data: packs = [] } = useQuery<{ id: string; name: string; personaId: string }[]>({
    queryKey: packKeys.list(),
    queryFn: listPacks,
    staleTime: 30_000,
  });
  const packForPersona = (personaId: string) => packs.find((p) => p.personaId === personaId);

  const remove = useMutation({
    mutationFn: (id: string) => deletePersona(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personas'] }),
  });

  const card = (p: Persona, isVariant: boolean) => {
    const pack = packForPersona(p.id);
    const stats = statsFor(pack?.id, leaves);
    return (
      <div
        key={p.id}
        className={`group rounded-2xl border border-[var(--bark-600)] bg-[var(--bark-800)]/40 hover:bg-[var(--bark-800)]/70 hover:border-[var(--bark-500,#334)] transition-colors p-4 ${isVariant ? 'ml-8' : ''}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-1.5 min-w-0">
            {isVariant && <CornerDownRight size={13} className="text-slate-600 mt-1 shrink-0" />}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-slate-200">{p.name}</span>
                {pack ? (
                  <button
                    onClick={() => setConfiguringPackId(pack.id)}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--bark-700)] text-emerald-400 hover:bg-[var(--bark-600)] transition-colors"
                  >
                    {pack.name}
                  </button>
                ) : (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--bark-700)] text-slate-500">no pack</span>
                )}
              </div>
              {p.description && <div className="text-[12px] text-slate-500 leading-snug mt-1">{p.description}</div>}
            </div>
          </div>

          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            {pack ? (
              <button
                onClick={() => setConfiguringPackId(pack.id)}
                title="Configure pack — tools, sampling, prompt"
                className="p-1.5 rounded-lg text-slate-500 hover:text-emerald-400 hover:bg-[var(--bark-700)]"
              >
                <Sliders size={13} />
              </button>
            ) : (
              <button onClick={() => setEditing(p)} title="Edit" className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-[var(--bark-700)]">
                <Pencil size={13} />
              </button>
            )}
            <button onClick={() => remove.mutate(p.id)} title="Delete" className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-[var(--bark-700)]">
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4 mt-3 text-[12px]">
          <span className="text-slate-400" title={`${stats.assigned} assigned, ${stats.finished} finished`}>
            <span className="text-slate-600 uppercase text-[10px] font-black tracking-widest mr-1.5">Ran</span>
            {stats.assigned === 0 ? <span className="text-slate-600">never used</span> : stats.finished}
          </span>
          <span title="Share of finished leaves a check actually passed">
            <span className="text-slate-600 uppercase text-[10px] font-black tracking-widest mr-1.5">Verified</span>
            <Rate stats={stats} />
          </span>
          <span className="text-slate-400" title="Median tokens per run — a median so one runaway does not redefine the cost">
            <span className="text-slate-600 uppercase text-[10px] font-black tracking-widest mr-1.5">Typical</span>
            {tokens(stats.medianTokens)}
          </span>
          <span title="Leaves that needed more than one attempt">
            <span className="text-slate-600 uppercase text-[10px] font-black tracking-widest mr-1.5">Retried</span>
            {stats.retried > 0
              ? <span className="text-amber-400/80">{stats.retried}</span>
              : <span className="text-slate-600">—</span>}
          </span>
        </div>
      </div>
    );
  };

  return (
    <section className="p-6">
      <header className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold">Personas</h2>
          <p className="text-[13px] text-slate-400">
            Everything about how an agent runs — its prompt, its tools, its sandbox and what it can reach —
            beside what it has actually delivered.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white px-4 py-2 rounded-xl flex items-center gap-2 text-[13px] font-medium shrink-0"
        >
          <Plus size={16} /> New persona
        </button>
      </header>

      {isLoading ? (
        <div className="text-slate-500 flex items-center gap-2"><Loader2 className="animate-spin" size={18} /> Loading…</div>
      ) : personas.length === 0 ? (
        <p className="text-slate-500 text-sm p-6 rounded-2xl border border-[var(--bark-600)] bg-[var(--bark-800)]/40">
          No personas yet. A leaf cannot run without one.
        </p>
      ) : (
        <div className="space-y-3">
          {byLineage(personas).map(({ root, variants }) => (
            <Fragment key={root.id}>
              {card(root, false)}
              {variants.map((v) => card(v, true))}
            </Fragment>
          ))}
        </div>
      )}

      {(editing || creating) && (
        <PersonaEditor
          {...(editing ? { persona: editing } : {})}
          personas={personas}
          onClose={() => { setEditing(null); setCreating(false); }}
        />
      )}

      {configuringPackId && (
        <PersonaConfigDrawer
          isOpen={true}
          onClose={() => setConfiguringPackId(null)}
          activePackId={configuringPackId}
          onSelectPack={setConfiguringPackId}
        />
      )}
    </section>
  );
}
