import { useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Loader2, Trash2, Pencil, ShieldAlert, ShieldOff, CornerDownRight } from 'lucide-react';
import PersonaEditor, { type Persona } from './PersonaEditor.js';
import { statsFor, byLineage, type PersonaStats } from './persona-stats.js';
import type { Leaf } from './leaf-types.js';
import { listPersonas, deletePersona, personaKeys } from '../api/personas';
import { listLeaves, groveKeys } from '../api/grove';

/**
 * The personas, side by side.
 *
 * ── WHY A TABLE AND NOT CARDS ──
 * These were a grid of cards whose footer was a bag of optional chips, so no two rendered the same
 * shape: Framer read `sealed · base · 20 steps · 3 tools` while Builder read
 * `reaches gitea, koala-registry · repo · 4 tools` — no isolation word, no step count, different
 * order. Every one of those is a property you would compare ACROSS personas, and the layout made
 * comparing them impossible; you had to read nine cards and hold them in your head.
 *
 * ── AND WHY IT MEASURES THEM ──
 * Nothing here said whether a persona was any good. The Lab runs experiments comparing exactly
 * that, and every leaf already carries `personaId`, `verified`, tokens and attempts. The numbers
 * existed and were shown nowhere near the thing they describe.
 */

/** A rate is a judgement, so it is coloured only where it is confident. */
function Rate({ stats }: { stats: PersonaStats }) {
  if (stats.verifiedRate === undefined) {
    // Not "0%" — a persona that has never finished anything has not failed at anything either.
    return <span className="text-slate-600">—</span>;
  }
  const pct = Math.round(stats.verifiedRate * 100);
  // Under five finished runs this is noise, so it is shown without a verdict colour.
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

  const { data: personas = [], isLoading } = useQuery<Persona[]>({
    queryKey: personaKeys.list(),
    queryFn: listPersonas,
  });
  const { data: leaves = [] } = useQuery<Leaf[]>({
    queryKey: groveKeys.leaves(),
    queryFn: listLeaves,
    staleTime: 30_000,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deletePersona(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personas'] }),
  });

  const row = (p: Persona, isVariant: boolean) => {
    const egress = p.scope?.egress ?? [];
    const stats = statsFor(p.id, leaves);
    return (
      <tr key={p.id} className="border-t border-[var(--bark-700)] hover:bg-[var(--bark-800)]/60 group">
        <td className="py-2.5 pr-3">
          <div className={`flex items-start gap-1.5 ${isVariant ? 'pl-5' : ''}`}>
            {isVariant && <CornerDownRight size={12} className="text-slate-600 mt-1 shrink-0" />}
            <div className="min-w-0">
              <div className="font-semibold text-slate-200 truncate">{p.name}</div>
              {p.description && <div className="text-[11px] text-slate-500 leading-snug">{p.description}</div>}
            </div>
          </div>
        </td>

        {/* Isolation first among the settings, because it is the thing most likely to be wrong and
            the thing nobody thinks to check — it decides whether an agent can install a dependency
            or spends three attempts discovering it cannot. */}
        <td className="py-2.5 pr-3 whitespace-nowrap">
          {egress.length === 0 ? (
            <span className="flex items-center gap-1.5 text-amber-400/80" title="DNS only — installs and downloads will fail">
              <ShieldAlert size={12} /> sealed
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-slate-400" title={egress.map((e) => e.namespace ?? e.cidr).join(', ')}>
              <ShieldOff size={12} /> {egress.map((e) => e.namespace ?? e.cidr).join(', ')}
            </span>
          )}
        </td>
        <td className="py-2.5 pr-3 text-slate-400 whitespace-nowrap">{p.scope?.run?.maxSteps ?? '—'}</td>
        <td className="py-2.5 pr-3 text-slate-400 whitespace-nowrap">
          {p.scope?.tools?.length ? p.scope.tools.length : <span title="Every tool the harness offers">all</span>}
        </td>
        <td className="py-2.5 pr-3 text-slate-500 whitespace-nowrap">{p.scope?.repo ? 'yes' : '—'}</td>

        {/* ── Measured, not configured ── */}
        <td className="py-2.5 pr-3 text-slate-400 whitespace-nowrap" title={`${stats.assigned} assigned, ${stats.finished} finished`}>
          {stats.assigned === 0 ? <span className="text-slate-600">never used</span> : stats.finished}
        </td>
        <td className="py-2.5 pr-3 whitespace-nowrap"><Rate stats={stats} /></td>
        <td className="py-2.5 pr-3 text-slate-400 whitespace-nowrap" title="Median tokens per run — a median so one runaway does not redefine the cost">
          {tokens(stats.medianTokens)}
        </td>
        <td className="py-2.5 pr-3 whitespace-nowrap">
          {stats.retried > 0
            ? <span className="text-amber-400/80" title="Leaves that needed more than one attempt">{stats.retried}</span>
            : <span className="text-slate-600">—</span>}
        </td>

        <td className="py-2.5 text-right whitespace-nowrap">
          <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => setEditing(p)} className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-[var(--bark-700)]">
              <Pencil size={13} />
            </button>
            <button onClick={() => remove.mutate(p.id)} className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-[var(--bark-700)]">
              <Trash2 size={13} />
            </button>
          </div>
        </td>
      </tr>
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
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[var(--bark-600)] bg-[var(--bark-800)]/40">
          <table className="w-full text-[12px] text-left">
            <thead>
              <tr className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                <th className="py-2.5 px-3 font-black">Persona</th>
                <th className="py-2.5 pr-3 font-black">Reaches</th>
                <th className="py-2.5 pr-3 font-black">Steps</th>
                <th className="py-2.5 pr-3 font-black">Tools</th>
                <th className="py-2.5 pr-3 font-black">Repo</th>
                {/* The three that are measured rather than set, kept together and labelled so the
                    difference is legible. */}
                <th className="py-2.5 pr-3 font-black text-[var(--leaf)]" title="Leaves that reached a terminal state">Ran</th>
                <th className="py-2.5 pr-3 font-black text-[var(--leaf)]" title="Share of finished leaves a check actually passed — never the agent's own report">Verified</th>
                <th className="py-2.5 pr-3 font-black text-[var(--leaf)]" title="Median tokens per run">Typical</th>
                <th className="py-2.5 pr-3 font-black text-[var(--leaf)]" title="Leaves that needed more than one attempt">Retried</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {byLineage(personas).map(({ root, variants }) => (
                <Fragment key={root.id}>
                  {row(root, false)}
                  {/* Variants directly under what they were forked from: comparing a fork against
                      its parent is the one comparison anybody wants, and creation order buried it. */}
                  {variants.map((v) => row(v, true))}
                </Fragment>
              ))}
            </tbody>
          </table>
          {personas.length === 0 && (
            <p className="text-slate-500 text-sm p-6">No personas yet. A leaf cannot run without one.</p>
          )}
        </div>
      )}

      {(editing || creating) && (
        <PersonaEditor
          {...(editing ? { persona: editing } : {})}
          personas={personas}
          onClose={() => { setEditing(null); setCreating(false); }}
        />
      )}
    </section>
  );
}
