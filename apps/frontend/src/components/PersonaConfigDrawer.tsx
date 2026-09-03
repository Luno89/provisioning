import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Sliders, X, Check, Loader2, Sparkles, Wrench, Network, FileText,
  Save
} from 'lucide-react';
import {
  listPersonas, updatePersona, getPersonaOptions,
  personaKeys
} from '../api/personas.js';
import { listPacks, updatePack, packKeys, type PersonaPack } from '../api/packs';
import { listModels, providerKeys, useDefaultModel, type ModelProvider } from '../api/models';
import { modelOptionLabel } from '../lib/model-label';
import { listTools, toolKeys } from '../api/harness/tools.js';
import { getConfig, profileKeys } from '../api/harness/profile.js';
import type { Tunable } from '@koala/harness-types';
import type { Persona } from './PersonaEditor.js';
import { errorMessage } from '../api/client.js';
import ToolGrantList from './ToolGrantList.js';
import { packEditFromKnobs, packValueAt, describeTunable } from '../lib/pack-editor.js';

interface ToolItem {
  name: string;
  description?: string;
  category: string;
  needs?: string[];
}

/** Dotted paths into `PersonaPack.prompt.sections` — reuses `packEditFromKnobs`'s generic
 * dotted-path writer, the same mechanism the sampling knob grid below uses. */
const PROMPT_SECTIONS: { key: string; label: string; path: string }[] = [
  { key: 'roleAdmin', label: 'Role — admin', path: 'prompt.sections.role.admin' },
  { key: 'roleEscalated', label: 'Role — escalated', path: 'prompt.sections.role.escalated' },
  { key: 'roleStandard', label: 'Role — standard', path: 'prompt.sections.role.standard' },
  { key: 'secrets', label: 'Secrets', path: 'prompt.sections.secrets' },
  { key: 'toolGuidance', label: 'Tool guidance heading', path: 'prompt.sections.toolGuidance' },
  { key: 'servicesNone', label: 'Services — none available', path: 'prompt.sections.services.none' },
  { key: 'servicesHeading', label: 'Services — heading', path: 'prompt.sections.services.heading' },
  { key: 'memories', label: 'Memories', path: 'prompt.sections.memories' },
  { key: 'pressureNotice', label: 'Context-pressure notice', path: 'prompt.sections.pressureNotice' },
  { key: 'toolDiscipline', label: 'Tool discipline', path: 'prompt.sections.toolDiscipline' },
  { key: 'planning', label: 'Planning contract', path: 'prompt.sections.planning' },
  { key: 'ambientPlanning', label: 'Ambient planning contract', path: 'prompt.sections.ambientPlanning' },
  { key: 'extraction', label: 'Extraction prompt', path: 'prompt.sections.extraction' },
  { key: 'assignmentNudge', label: 'Assignment nudge', path: 'prompt.sections.assignmentNudge' },
];

export function PersonaConfigDrawer({
  isOpen,
  onClose,
  activePackId,
  onSelectPack,
}: {
  isOpen: boolean;
  onClose: () => void;
  activePackId: string;
  onSelectPack: (packId: string) => void;
}) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>(activePackId);

  const { data: packs = [] } = useQuery<PersonaPack[]>({
    queryKey: packKeys.list(),
    queryFn: listPacks,
    enabled: isOpen,
  });

  const { data: personas = [] } = useQuery<Persona[]>({
    queryKey: personaKeys.list(),
    queryFn: listPersonas,
    enabled: isOpen,
  });

  const { data: allTools = [] } = useQuery<ToolItem[]>({
    queryKey: toolKeys.list(),
    queryFn: listTools,
    enabled: isOpen,
  });

  const { data: models = [] } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
    enabled: isOpen,
  });

  const { data: defaultSetting } = useDefaultModel();
  const defaultModelId = defaultSetting?.defaultModelId ?? null;
  const defaultModel = models.find((m) => m.id === defaultModelId);

  const { data: harnessConfig } = useQuery({
    queryKey: profileKeys.config(),
    queryFn: getConfig,
    enabled: isOpen,
  });
  const packTunables = (harnessConfig?.tunables ?? []).filter((t: Tunable) =>
    t.path && (!t.settableAt || t.settableAt.includes('pack')));

  const { data: personaOptions } = useQuery({
    queryKey: personaKeys.options(),
    queryFn: getPersonaOptions,
    enabled: isOpen,
  });
  const mcpServers = personaOptions?.mcpServers ?? [];

  const currentPack = packs.find((p) => p.id === selectedId || p.slug === selectedId);
  const currentPersona =
    personas.find((p) => p.id === currentPack?.personaId)
    ?? personas.find((p) => p.name === currentPack?.name);

  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftTools, setDraftTools] = useState<string[]>([]);
  const [draftMcp, setDraftMcp] = useState<string[]>([]);
  const [draftModelId, setDraftModelId] = useState<string>('');
  const [draftKnobs, setDraftKnobs] = useState<Record<string, unknown>>({});
  const [draftSections, setDraftSections] = useState<Record<string, string>>({});
  const [draftOutput, setDraftOutput] = useState('');
  const [draftTunedFor, setDraftTunedFor] = useState('');
  const [draftCanRunLeaf, setDraftCanRunLeaf] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!currentPack) return;
    setDraftName(currentPack.name);
    setDraftDesc(currentPack.description ?? '');
    setDraftPrompt(currentPersona?.systemPrompt ?? '');
    setDraftTools(currentPack.tools ?? []);
    setDraftMcp(currentPack.mcp ?? []);
    setDraftModelId((currentPack as any).model?.endpointId ?? '');
    setDraftKnobs({});
    setDraftSections({});
    setDraftOutput(currentPack.output ?? '');
    setDraftTunedFor(currentPack.tunedFor ?? '');
    setDraftCanRunLeaf(Boolean(currentPack.canRunLeaf));
    setStatusMsg(null);
  }, [currentPack, currentPersona]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!currentPack) return;
      const known = new Set(allTools.map((t) => t.name));
      const knobEdit = packEditFromKnobs(draftKnobs, packTunables);
      const sectionsEdit = packEditFromKnobs(draftSections, PROMPT_SECTIONS);
      await updatePack(currentPack.id, {
        name: draftName,
        description: draftDesc,
        tools: draftTools.filter((t) => known.has(t)),
        mcp: draftMcp,
        canRunLeaf: draftCanRunLeaf,
        ...(draftOutput ? { output: draftOutput } : {}),
        ...(draftTunedFor ? { tunedFor: draftTunedFor } : {}),
        ...knobEdit,
        ...sectionsEdit,
        ...(draftModelId ? { model: { endpointId: draftModelId } } : { model: { endpointId: null } }),
      });
      if (currentPersona && draftPrompt !== (currentPersona.systemPrompt ?? '')) {
        await updatePersona(currentPersona.id, { systemPrompt: draftPrompt });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: packKeys.list() });
      qc.invalidateQueries({ queryKey: personaKeys.list() });
      setStatusMsg({ type: 'ok', text: 'Saved.' });
      setTimeout(() => setStatusMsg(null), 3000);
    },
    onError: (err) => {
      setStatusMsg({ type: 'err', text: errorMessage(err) });
    },
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150 font-sans">
      <div className="relative w-full max-w-4xl max-h-[90vh] bg-[var(--bark-900,#111814)] border border-[var(--bark-700,#24332b)] rounded-lg shadow-2xl flex flex-col overflow-hidden text-slate-200">
        <div className="flex items-center justify-between px-5 py-3.5 bg-[var(--bark-950,#090d0b)] border-b border-[var(--bark-800,#1b2620)]">
          <div className="flex items-center gap-2">
            <div className="p-1 rounded bg-emerald-500/10 text-emerald-400">
              <Sliders size={15} />
            </div>
            <div>
              <h3 className="text-xs font-bold text-slate-100 uppercase tracking-wide">Persona & Capabilities</h3>
              <p className="text-[11px] text-slate-400 font-sans">
                Customize agent system directives, tools, and attached services
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-100 hover:bg-[var(--bark-800,#1b2620)] rounded-md transition-colors cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto grid grid-cols-1 md:grid-cols-12 divide-y md:divide-y-0 md:divide-x divide-[var(--bark-800,#1b2620)]">
          <div className="md:col-span-4 p-3 bg-[var(--bark-950,#090d0b)]/40 space-y-2">
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider px-1">
              Packs ({packs.length})
            </div>

            <div className="space-y-1">
              {packs.map((p) => {
                const isSelected = p.id === selectedId || p.slug === selectedId;
                const isCurrentPack = p.id === activePackId || p.slug === activePackId;

                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(p.id);
                      onSelectPack(p.id);
                    }}
                    className={`w-full text-left p-2.5 rounded-md border transition-colors text-xs flex items-center justify-between cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--bark-800,#1b2620)] border-emerald-500/50 text-slate-100'
                        : 'bg-[var(--bark-900,#111814)] border-[var(--bark-800,#1b2620)] text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <div className="min-w-0 pr-2">
                      <div className="font-semibold flex items-center gap-1.5 truncate">
                        <Sparkles size={12} className={isSelected ? 'text-emerald-400' : 'text-slate-500'} />
                        <span>{p.name}</span>
                      </div>
                      {p.description && (
                        <div className="text-[11px] text-slate-400 truncate mt-0.5 font-sans">
                          {p.description}
                        </div>
                      )}
                    </div>
                    {isCurrentPack && (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-950/80 border border-emerald-500/40 text-[9px] font-mono text-emerald-400 font-bold uppercase shrink-0">
                        Active
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="md:col-span-8 p-5 space-y-5 bg-[var(--bark-900,#111814)]">
            {currentPack ? (
              <>
                <div className="space-y-3.5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-semibold text-slate-300 block mb-1">
                        Pack Name
                      </label>
                      <input
                        type="text"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-300 block mb-1">
                        Description
                      </label>
                      <input
                        type="text"
                        value={draftDesc}
                        onChange={(e) => setDraftDesc(e.target.value)}
                        className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-300 block mb-1">
                      System Instructions
                    </label>
                    <textarea
                      rows={5}
                      value={draftPrompt}
                      onChange={(e) => setDraftPrompt(e.target.value)}
                      placeholder="Define the behavior, personality, and instructions for this agent..."
                      className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md p-2.5 text-xs text-slate-100 focus:outline-none leading-relaxed resize-y font-sans"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                    <div>
                      <label className="text-xs font-semibold text-slate-300 block mb-1" title="Where this pack's product lands in the shared workspace, e.g. /work/findings.md">
                        Output file
                      </label>
                      <input
                        type="text"
                        value={draftOutput}
                        onChange={(e) => setDraftOutput(e.target.value)}
                        placeholder="/work/findings.md"
                        className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-300 block mb-1" title="Which deployment this pack's sampling/DRY values were tuned against">
                        Tuned for
                      </label>
                      <input
                        type="text"
                        value={draftTunedFor}
                        onChange={(e) => setDraftTunedFor(e.target.value)}
                        className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none"
                      />
                    </div>
                  </div>

                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer" title="Whether this pack does sandboxed work (a leaf can be assigned to it) vs. conversation-only (planner/judge/merger roles)">
                    <input
                      type="checkbox"
                      checked={draftCanRunLeaf}
                      onChange={(e) => setDraftCanRunLeaf(e.target.checked)}
                      className="accent-emerald-500"
                    />
                    Can run leaf sandboxes
                  </label>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-300 block mb-1">Model</label>
                  <select
                    value={draftModelId}
                    onChange={(e) => setDraftModelId(e.target.value)}
                    className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none"
                  >
                    <option value="">Use the account default{defaultModel ? ` (${modelOptionLabel(defaultModel)})` : ' — none set'}</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {modelOptionLabel(m)}
                      </option>
                    ))}
                    {models.length === 0 && (
                      <option value="" disabled>No models connected — add one in Cloud Accounts</option>
                    )}
                  </select>
                </div>

                {packTunables.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
                      <Sliders size={13} className="text-emerald-400" />
                      <span>Sampling & budget</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {packTunables.map((t: Tunable) => {
                        const current = draftKnobs[t.key] !== undefined
                          ? draftKnobs[t.key]
                          : packValueAt(currentPack, t.path);
                        const setKnob = (val: unknown) => setDraftKnobs((prev) => ({ ...prev, [t.key]: val }));
                        return (
                          <div key={t.key} title={describeTunable(t, undefined)}>
                            <label className="text-[10px] text-slate-400 font-mono block mb-0.5 truncate cursor-help flex items-center gap-1">
                              {t.label}
                              <span className="text-slate-600 normal-case">· {t.group}</span>
                            </label>
                            {t.type === 'number' && (
                              <input
                                type="number"
                                step={t.step ?? 0.05}
                                min={t.min}
                                max={t.max}
                                value={current === undefined || current === null ? '' : Number(current)}
                                placeholder={t.default !== undefined ? String(t.default) : 'unset'}
                                onChange={(e) => setKnob(e.target.value === '' ? undefined : Number(e.target.value))}
                                className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md px-2 py-1 text-[11px] text-slate-100 focus:outline-none"
                              />
                            )}
                            {t.type === 'boolean' && (
                              <select
                                value={current === undefined || current === null ? '' : String(current)}
                                onChange={(e) => setKnob(e.target.value === '' ? undefined : e.target.value === 'true')}
                                className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md px-2 py-1 text-[11px] text-slate-100 focus:outline-none"
                              >
                                <option value="">unset</option>
                                <option value="true">true</option>
                                <option value="false">false</option>
                              </select>
                            )}
                            {t.type === 'enum' && t.options && (
                              <select
                                value={current === undefined || current === null ? '' : String(current)}
                                onChange={(e) => setKnob(e.target.value === '' ? undefined : e.target.value)}
                                className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md px-2 py-1 text-[11px] text-slate-100 focus:outline-none"
                              >
                                <option value="">unset</option>
                                {t.options.map((opt) => (
                                  <option key={String(opt)} value={String(opt)}>{String(opt)}</option>
                                ))}
                              </select>
                            )}
                            {t.type === 'string' && !t.options && (
                              <input
                                type="text"
                                value={current === undefined || current === null ? '' : String(current)}
                                placeholder={t.default !== undefined ? String(t.default) : 'unset'}
                                onChange={(e) => setKnob(e.target.value === '' ? undefined : e.target.value)}
                                className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md px-2 py-1 text-[11px] text-slate-100 focus:outline-none"
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="space-y-2.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
                    <Wrench size={13} className="text-emerald-400" />
                    <span>Enabled Capabilities & Tools</span>
                  </div>

                  <ToolGrantList
                    tools={allTools}
                    selected={draftTools}
                    onChange={setDraftTools}
                    hasSandbox={Boolean(currentPack?.canRunLeaf)}
                  />

                </div>

                <div className="space-y-2.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
                    <Network size={13} className="text-emerald-400" />
                    <span>MCP services</span>
                  </div>
                  {mcpServers.length === 0 ? (
                    <p className="text-[11px] text-slate-500">
                      Nothing deployed under this account yet. Build and deploy a project to offer it here.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {mcpServers.map((s) => {
                        const on = draftMcp.includes(s.name);
                        return (
                          <label
                            key={s.name}
                            className="flex items-center gap-2 text-xs text-slate-300 px-2 py-1.5 rounded-md border border-[var(--bark-800,#1b2620)] hover:border-slate-600 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => setDraftMcp((prev) => (
                                on ? prev.filter((n) => n !== s.name) : [...prev, s.name]
                              ))}
                              className="accent-emerald-500"
                            />
                            <span className="flex-1">{s.name}</span>
                            {s.unreachable
                              ? <span className="text-amber-400/80 text-[10px]" title={s.unreachable}>unreachable</span>
                              : <span className="text-slate-500 text-[10px]">{s.tools} tools</span>}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="space-y-2.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
                    <FileText size={13} className="text-emerald-400" />
                    <span>Prompt sections</span>
                  </div>
                  <div className="space-y-2.5">
                    {PROMPT_SECTIONS.map((f) => {
                      const current = draftSections[f.key] !== undefined
                        ? draftSections[f.key]
                        : String(packValueAt(currentPack, f.path) ?? '');
                      return (
                        <div key={f.key}>
                          <label className="text-[10px] text-slate-400 font-mono block mb-0.5">
                            {f.label}
                          </label>
                          <textarea
                            rows={2}
                            value={current}
                            onChange={(e) => setDraftSections((prev) => ({ ...prev, [f.key]: e.target.value }))}
                            className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md p-2 text-[11px] text-slate-100 focus:outline-none leading-relaxed resize-y font-sans"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center py-12 text-slate-500 text-xs font-sans">
                Select a pack from the list to view and configure how it runs.
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-3 bg-[var(--bark-950,#090d0b)] border-t border-[var(--bark-800,#1b2620)]">
          <div>
            {statusMsg && (
              <div
                className={`text-xs flex items-center gap-1.5 ${
                  statusMsg.type === 'ok' ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {statusMsg.type === 'ok' ? <Check size={13} /> : <X size={13} />}
                <span>{statusMsg.text}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md border border-[var(--bark-700,#24332b)] hover:bg-[var(--bark-800,#1b2620)] text-slate-300 text-xs transition-colors cursor-pointer"
            >
              Close
            </button>

            <button
              type="button"
              disabled={saveMutation.isPending || !currentPack}
              onClick={() => saveMutation.mutate()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-md text-xs font-medium transition-colors cursor-pointer"
            >
              {saveMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              <span>Save Configuration</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PersonaConfigDrawer;