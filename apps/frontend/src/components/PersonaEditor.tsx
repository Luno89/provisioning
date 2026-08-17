import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { X, Loader2, Plus, Trash2, ShieldAlert, Boxes } from 'lucide-react';

/**
 * Everything a persona is, editable.
 *
 * ── WHY THIS HAS TO EXIST ──
 * A persona carries the entire environment a leaf runs in — the image, the CPU and memory, the
 * tools it may call, the network it may reach, the step budget, where its output goes. All of it
 * was fixed by a seed script, and the API accepted edits to four fields: name, description, prompt
 * and sampling overrides. Changing what the Builder could reach meant editing
 * `scripts/seed-personas.ts` and re-running it, which also rewrote every other persona on the way
 * past.
 *
 * ── THE EGRESS SECTION IS THE POINT ──
 * `egress` becomes the sandbox's NetworkPolicy. It is the difference between a container that can
 * reach a package registry and one that cannot, and until now it was unreachable from the UI while
 * being the single most common thing to need changed — measured: an agent spent three attempts
 * running `npm install` against a registry the policy blocks.
 *
 * Server-validated, deliberately, because a malformed rule fails in the direction that matters: the
 * pod comes up, the policy does not mean what was intended, and nothing says so.
 */

interface EgressRule { namespace?: string; cidr?: string; ports?: number[] }

interface Scope {
  language?: string;
  cpu?: string;
  memory?: string;
  repo?: boolean;
  output?: string;
  requireSources?: boolean;
  tools?: string[];
  egress?: EgressRule[];
  /** MCP servers this persona may call, by service name. */
  mcp?: string[];
  env?: { name: string; value: string }[];
  run?: { maxSteps?: number };
  tunedFor?: string;
}

export interface Persona {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  basedOn?: string;
  scope?: Scope;
  overrides?: Record<string, unknown>;
}

interface Options {
  languages: { id: string; image: string; summary: string; available: string[]; absent: string[] }[];
  tools: { name: string; description?: string }[];
  defaults: { cpu: string; memory: string; maxSteps: number };
}

const label = 'text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1 block';
const field = 'w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-lg px-3 py-2 text-[13px] text-slate-200';

export default function PersonaEditor({
  apiBase, persona, personas, onClose,
}: {
  apiBase: string;
  /** Absent means a new one. */
  persona?: Persona | undefined;
  personas: Persona[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Persona>(() => persona ?? { id: '', name: '', scope: {} });
  const [overridesText, setOverridesText] = useState(() => JSON.stringify(persona?.overrides ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  const { data: options } = useQuery<Options>({
    queryKey: ['persona-options'],
    queryFn: () => axios.get(`${apiBase}/persona-options`, { withCredentials: true }).then((r) => r.data),
    // The catalogue only changes when the code does.
    staleTime: Infinity,
  });

  const scope = draft.scope ?? {};
  const setScope = (patch: Partial<Scope>) => setDraft({ ...draft, scope: { ...scope, ...patch } });

  const save = useMutation({
    mutationFn: async () => {
      let overrides: Record<string, unknown>;
      try {
        overrides = JSON.parse(overridesText || '{}');
      } catch {
        // Thrown rather than sent: the server would reject it too, but with a message about the
        // registry rather than about the JSON, which is not the mistake that was made.
        throw new Error('The sampling overrides are not valid JSON.');
      }
      const body = {
        name: draft.name,
        description: draft.description ?? '',
        systemPrompt: draft.systemPrompt ?? '',
        basedOn: draft.basedOn ?? '',
        scope,
        overrides,
      };
      return persona
        ? axios.put(`${apiBase}/personas/${persona.id}`, body, { withCredentials: true })
        : axios.post(`${apiBase}/personas`, body, { withCredentials: true });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['personas'] }); onClose(); },
    onError: (err: any) => setError(err?.response?.data?.error ?? err?.message ?? 'Could not save.'),
  });

  const egress = scope.egress ?? [];
  const setEgress = (rules: EgressRule[]) => setScope({ egress: rules });

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

          {/* ── ISOLATION ── the reason this editor exists. */}
          <div className="border border-[var(--bark-600)] rounded-xl p-4 space-y-3">
            {/*
              * Services this harness has already built.
              *
              * Above isolation deliberately: naming one here is a NETWORK decision as much as a
              * capability, and the two settings have to agree. A server named without matching
              * egress is a tool the agent can see and every call times out.
              */}
            <div className="flex items-center gap-2">
              <Boxes size={14} className="text-[var(--leaf)]" />
              <span className="text-[12px] font-bold text-slate-200">Services it may call</span>
              <span className="text-[11px] text-slate-500">
                MCP servers this harness deployed — their tools are prefixed with the service name
              </span>
            </div>
            <input
              className={`${field} w-full`}
              placeholder="weather-api-mcp, github-api — comma separated, blank for none"
              value={(scope.mcp ?? []).join(', ')}
              onChange={(e) => setScope({
                mcp: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
              })}
            />
            {(scope.mcp ?? []).length > 0 && (scope.egress ?? []).length === 0 && (
              /* The disagreement worth catching here rather than mid-run: the tool would be
                 visible and every call would time out, with the cause three layers away. */
              <p className="text-[11px] text-amber-400/80">
                This persona is sealed, so it cannot reach any of these. Add the service's namespace
                to Isolation below or the tools will appear and every call will time out.
              </p>
            )}

            <div className="flex items-center gap-2 pt-3 border-t border-[var(--bark-700)]">
              <ShieldAlert size={14} className="text-amber-400" />
              <span className="text-[12px] font-bold text-slate-200">Isolation</span>
              <span className="text-[11px] text-slate-500">
                becomes the sandbox's NetworkPolicy — everything outbound is denied except DNS and these
              </span>
            </div>

            {egress.length === 0 && (
              <p className="text-[11px] text-slate-500">
                Nothing listed: this persona can reach DNS and nothing else. `npm install`, `pip install`
                and every download will fail.
              </p>
            )}

            {egress.map((rule, i) => (
              <div key={i} className="flex flex-wrap gap-2 items-center">
                <select
                  className={`${field} w-32`}
                  value={rule.cidr !== undefined ? 'cidr' : 'namespace'}
                  onChange={(e) => setEgress(egress.map((r, n) => n === i
                    // Exactly one of the two, because the server refuses a rule carrying both — a
                    // NodePort address does not work as a cidr, so they are not interchangeable.
                    ? (e.target.value === 'cidr' ? { cidr: '', ports: r.ports ?? [] } : { namespace: '', ports: r.ports ?? [] })
                    : r))}
                >
                  <option value="namespace">in-cluster</option>
                  <option value="cidr">CIDR</option>
                </select>
                <input
                  className={`${field} flex-1 min-w-[160px]`}
                  placeholder={rule.cidr !== undefined ? '10.0.0.0/8' : 'namespace, e.g. gitea'}
                  value={rule.cidr ?? rule.namespace ?? ''}
                  onChange={(e) => setEgress(egress.map((r, n) => n === i
                    ? (r.cidr !== undefined ? { ...r, cidr: e.target.value } : { ...r, namespace: e.target.value })
                    : r))}
                />
                <input
                  className={`${field} w-40`}
                  placeholder="ports, e.g. 443"
                  value={(rule.ports ?? []).join(', ')}
                  onChange={(e) => setEgress(egress.map((r, n) => n === i
                    ? { ...r, ports: e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0) }
                    : r))}
                />
                <button
                  onClick={() => setEgress(egress.filter((_, n) => n !== i))}
                  className="p-2 rounded-lg text-slate-500 hover:text-red-400"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}

            <button
              onClick={() => setEgress([...egress, { namespace: '', ports: [] }])}
              className="flex items-center gap-1.5 text-[12px] text-[var(--leaf)] hover:underline"
            >
              <Plus size={13} /> allow something
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <span className={label}>Toolchain</span>
              <select className={field} value={scope.language ?? ''} onChange={(e) => setScope({ language: e.target.value })}>
                <option value="">default</option>
                {(options?.languages ?? []).map((l) => <option key={l.id} value={l.id}>{l.id}</option>)}
              </select>
              {/* What the image actually has, so a persona is not configured for a toolchain that
                  is not in it — the failure that had an agent hunting for a test runner. */}
              <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
                {options?.languages.find((l) => l.id === scope.language)?.summary ?? 'Whatever the leaf asks for.'}
              </p>
            </div>
            <div>
              <span className={label}>CPU</span>
              <input className={field} placeholder={options?.defaults.cpu ?? '2'} value={scope.cpu ?? ''}
                onChange={(e) => setScope({ cpu: e.target.value })} />
            </div>
            <div>
              <span className={label}>Memory</span>
              <input className={field} placeholder={options?.defaults.memory ?? '2Gi'} value={scope.memory ?? ''}
                onChange={(e) => setScope({ memory: e.target.value })} />
            </div>
          </div>

          <div>
            <span className={label}>Tools it may call</span>
            <div className="flex flex-wrap gap-1.5">
              {(options?.tools ?? []).map((t) => {
                const on = (scope.tools ?? []).includes(t.name);
                return (
                  <button
                    key={t.name}
                    title={t.description}
                    onClick={() => setScope({
                      tools: on
                        ? (scope.tools ?? []).filter((x) => x !== t.name)
                        : [...(scope.tools ?? []), t.name],
                    })}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-mono ${on
                      ? 'bg-[var(--leaf-stem)] text-white'
                      : 'bg-[var(--bark-800)] text-slate-500 hover:text-slate-300'}`}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-500 mt-1.5">
              None selected means every tool the environment offers. Naming one it does not have does not conjure it.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <span className={label}>Step budget</span>
              <input
                className={field} type="number" placeholder={String(options?.defaults.maxSteps ?? 40)}
                value={scope.run?.maxSteps ?? ''}
                onChange={(e) => setScope({ run: { ...(scope.run ?? {}), maxSteps: Number(e.target.value) || undefined } })}
              />
            </div>
            <div>
              <span className={label}>Output file</span>
              <input className={field} placeholder="/work/findings.md" value={scope.output ?? ''}
                onChange={(e) => setScope({ output: e.target.value })} />
            </div>
            <div>
              <span className={label}>Tuned for</span>
              <input className={field} placeholder="a deployment name" value={scope.tunedFor ?? ''}
                onChange={(e) => setScope({ tunedFor: e.target.value })} />
            </div>
          </div>

          <div className="flex flex-wrap gap-5">
            <label className="flex items-center gap-2 text-[12px] text-slate-300">
              <input type="checkbox" checked={scope.repo === true} onChange={(e) => setScope({ repo: e.target.checked })} />
              Gets a repository checked out
            </label>
            <label className="flex items-center gap-2 text-[12px] text-slate-300">
              <input type="checkbox" checked={scope.requireSources === true}
                onChange={(e) => setScope({ requireSources: e.target.checked })} />
              Its findings must carry sources
            </label>
          </div>

          <div>
            <span className={label}>Sampling overrides</span>
            <textarea
              className={`${field} font-mono min-h-[80px]`}
              value={overridesText}
              onChange={(e) => setOverridesText(e.target.value)}
            />
            <p className="text-[10px] text-slate-500 mt-1">
              Checked against the tunable registry on save — an unknown key is refused rather than silently ignored.
            </p>
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
