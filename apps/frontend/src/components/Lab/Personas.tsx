import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { ExpandableText } from './ExpandableText';
import { card, describeTunable, errorMessage, type HarnessConfig, type Tunable } from './shared';
import { listPersonas, createPersona, updatePersona, deletePersona } from '../../api/personas';
import type { Persona as ApiPersona } from '../PersonaEditor';

export interface Persona {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  overrides: Record<string, unknown>;
}

const parseRaw = (raw: string, type: string): unknown => {
  const text = raw.trim();
  if (text === '') return undefined;
  if (type === 'number') {
    const n = Number(text);
    return Number.isNaN(n) ? text : n;
  }
  if (type === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    return text;
  }
  return raw;
};

const showRaw = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export function Personas({ config }: { config: HarnessConfig | undefined }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Persona | null>(null);
  const [error, setError] = useState('');

  const { data: personas } = useQuery<ApiPersona[]>({
    queryKey: ['personas'],
    queryFn: listPersonas,
  });

  const done = () => {
    setDraft(null);
    setError('');
    qc.invalidateQueries({ queryKey: ['personas'] });
  };

  const save = useMutation({
    mutationFn: (p: Persona) => (p.id
      ? updatePersona(p.id, p)
      : createPersona(p)),
    onSuccess: done,
    onError: (err: unknown) => setError(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deletePersona(id),
    onSuccess: done,
    onError: (err: unknown) => setError(errorMessage(err)),
  });

  const field = 'w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2 py-1.5 text-[12px] text-slate-200 focus:border-[var(--leaf)] focus:outline-none';
  const editing = draft;

  return (
    <section>
      <div className="flex items-center gap-3 mb-2">
        <h3 className="text-[10px] uppercase tracking-widest text-slate-500">
          Personas ({personas?.length ?? 0})
        </h3>
        <button
          onClick={() => setDraft({ id: '', name: '', overrides: {} })}
          className="flex items-center gap-1 text-[11px] text-[var(--leaf-light)] hover:text-white"
        >
          <Plus size={11} /> New
        </button>
      </div>

      <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">
        A persona is a prompt and a set of knobs you can choose per conversation, per leaf, or per
        experiment arm. It layers on top of the adopted defaults and under whatever the turn itself
        asks for: <span className="font-mono text-slate-400">built-in → adopted → persona → request</span>.
      </p>

      {error && <p className="text-[11px] text-amber-400 mb-2">{error}</p>}

      <div className="space-y-2">
        {(personas ?? []).map((p) => (
          <div key={p.id} className={card}>
            <button
              onClick={() => setOpen(open === p.id ? null : p.id)}
              className="w-full flex items-center gap-2 px-4 py-3 text-left"
            >
              {open === p.id ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
              <span className="font-semibold text-slate-200">{p.name}</span>
              <span className="text-[12px] text-slate-500 truncate">{p.description}</span>
              <span className="ml-auto text-[10px] text-slate-600 whitespace-nowrap">
                {Object.keys(p.overrides ?? {}).length} knob
                {Object.keys(p.overrides ?? {}).length === 1 ? '' : 's'}
                {p.systemPrompt ? ' · prompt' : ''}
              </span>
            </button>

            {open === p.id && (
              <div className="px-4 pb-4 border-t border-[var(--bark-600)] pt-3 space-y-2">
                {p.systemPrompt && (
                  <pre className="text-[11px] text-slate-400 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                    {p.systemPrompt}
                  </pre>
                )}
                {Object.entries(p.overrides ?? {}).map(([key, value]) => (
                  <p key={key} className="text-[11px] font-mono">
                    <span className="text-slate-500">{key}</span>{' '}
                    <span className="text-[var(--leaf-light)]">{showRaw(value)}</span>
                  </p>
                ))}
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={() => { setDraft({ ...p, overrides: { ...p.overrides } }); setError(''); }}
                    className="text-[11px] text-[var(--leaf-light)] hover:text-white"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove.mutate(p.id)}
                    className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-red-400"
                  >
                    <Trash2 size={10} /> Delete
                  </button>
                  <span className="text-[10px] text-slate-600">
                    Leaves that already ran keep their record — they simply run with no persona next time.
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <div className={`${card} p-4 mt-2 space-y-3`}>
          <div className="grid grid-cols-2 gap-2">
            <input
              className={field}
              placeholder="Name — e.g. Reviewer"
              value={editing.name}
              onChange={(e) => setDraft({ ...editing, name: e.target.value })}
            />
            <input
              className={field}
              placeholder="One line: why you would pick this one"
              value={editing.description ?? ''}
              onChange={(e) => setDraft({ ...editing, description: e.target.value })}
            />
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">System prompt</p>
            <ExpandableText
              label={`Persona prompt — ${editing.name || 'new'}`}
              value={editing.systemPrompt ?? ''}
              rows={5}
              field={field}
              placeholder="Who this is. Left empty, the persona only changes knobs."
              onChange={(v) => setDraft((d) => (d ? { ...d, systemPrompt: v } : d))}
            />
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Knobs (raw values)</p>
            <table className="w-full text-[11px]">
              <tbody>
                {(config?.tunables ?? []).map((t: Tunable) => {
                  const live = config?.effective?.find((e) => e.key === t.key);
                  return (
                    <tr key={t.key} title={describeTunable(t, live)}>
                      <td className="py-0.5 pr-2 font-mono text-slate-400 align-middle whitespace-nowrap cursor-help">
                        {t.key}
                      </td>
                      <td className="py-0.5 w-full">
                        {t.choices ? (
                          <select
                            className={`${field} py-0.5`}
                            value={showRaw(editing.overrides[t.key])}
                            onChange={(e) => setDraft((d) => {
                              if (!d) return d;
                              const next = { ...d.overrides };
                              if (e.target.value === '') delete next[t.key];
                              else next[t.key] = e.target.value;
                              return { ...d, overrides: next };
                            })}
                          >
                            <option value="">unset — inherits</option>
                            {t.choices.map((c) => (
                              <option key={c.value} value={c.value}>{c.label}</option>
                            ))}
                          </select>
                        ) : (
                          <ExpandableText
                            label={t.label}
                            value={showRaw(editing.overrides[t.key])}
                            rows={1}
                            field={`${field} py-0.5`}
                            placeholder={showRaw(live ? live.value : t.default) || 'unset'}
                            expandable={t.type === 'string'}
                            {...(t.type === 'string' ? {
                              fallback: showRaw(live ? live.value : t.default),
                              fallbackNote: live?.source === 'adopted' ? 'adopted default' : 'harness default',
                            } : {})}
                            onChange={(raw) => setDraft((d) => {
                              if (!d) return d;
                              const next = { ...d.overrides };
                              const parsed = parseRaw(raw, t.type);
                              if (parsed === undefined) delete next[t.key];
                              else next[t.key] = parsed;
                              return { ...d, overrides: next };
                            })}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => save.mutate(editing)}
              disabled={save.isPending || !editing.name.trim()}
              className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-40"
            >
              {save.isPending && <Loader2 size={12} className="animate-spin" />}
              {editing.id ? 'Save persona' : 'Create persona'}
            </button>
            <button onClick={() => { setDraft(null); setError(''); }} className="text-[12px] text-slate-500 hover:text-slate-300">
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
