import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Sliders, X, Check, Loader2, Sparkles, Wrench,
  Save
} from 'lucide-react';
import {
  listPersonas, updatePersona,
  personaKeys
} from '../api/personas.js';
import { listPacks, updatePack, packKeys, type PersonaPack } from '../api/packs';
import { listModels, providerKeys, type ModelProvider } from '../api/models';
import { listTools, toolKeys } from '../api/harness/tools.js';
import type { Persona } from './PersonaEditor.js';
import { errorMessage } from '../api/client.js';

interface ToolItem {
  name: string;
  description?: string;
  category: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  assistant: 'Project & Infra Tools',
  web: 'Web & Search',
  sandbox: 'Sandbox (Build)',
  planning: 'Planning',
  git: 'Git',
  http: 'HTTP',
  linter: 'Lint',
  database: 'Database',
  custom: 'Custom',
};

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

  const currentPack = packs.find((p) => p.id === selectedId || p.slug === selectedId);
  const currentPersona =
    personas.find((p) => p.id === currentPack?.personaId)
    // A user's custom persona with the same name replaces the built-in in the
    // visible list (withBuiltIns keys by name), so an ID match can miss.
    ?? personas.find((p) => p.name === currentPack?.name);

  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftTools, setDraftTools] = useState<string[]>([]);
  const [draftModelId, setDraftModelId] = useState<string>('');
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!currentPack) return;
    setDraftName(currentPack.name);
    setDraftDesc(currentPack.description ?? '');
    setDraftPrompt(currentPersona?.systemPrompt ?? '');
    setDraftTools(currentPack.tools ?? []);
    setDraftModelId((currentPack as any).model?.endpointId ?? '');
    setStatusMsg(null);
  }, [currentPack, currentPersona]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!currentPack) return;
      // Round-trip tools only; sampling/budget/prompt are not edited here.
      await updatePack(currentPack.id, {
        name: draftName,
        description: draftDesc,
        tools: draftTools,
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

  const toggleTool = (toolName: string) => {
    setDraftTools((prev) =>
      prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName],
    );
  };

  // Group tools by category, sorted by category label order
  const categoryOrder = ['assistant', 'web', 'planning', 'sandbox', 'git', 'http', 'linter', 'database', 'custom'];
  const grouped = new Map<string, ToolItem[]>();
  for (const t of allTools) {
    const cat = t.category || 'custom';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(t);
  }

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
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-300 block mb-1">Model</label>
                  <select
                    value={draftModelId}
                    onChange={(e) => setDraftModelId(e.target.value)}
                    className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none"
                  >
                    <option value="">Pack default (pick in conversation)</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        [{m.sourceLabel || (m.source === 'deployment' ? (m.kind === 'tabbyapi' ? 'TabbyAPI' : 'vLLM') : 'Custom')}] {m.model || m.name}
                      </option>
                    ))}
                    {models.length === 0 && (
                      <option value="" disabled>No models connected — add one in Cloud Accounts</option>
                    )}
                  </select>
                </div>

                <div className="space-y-2.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
                    <Wrench size={13} className="text-emerald-400" />
                    <span>Enabled Capabilities & Tools</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {categoryOrder.map((cat) => {
                      const tools = grouped.get(cat);
                      if (!tools?.length) return null;
                      const label = CATEGORY_LABELS[cat] || cat;

                      return (
                        <div
                          key={cat}
                          className="bg-[var(--bark-950,#090d0b)] border border-[var(--bark-800,#1b2620)] rounded-md p-3 space-y-2"
                        >
                          <div className="text-slate-200 text-xs font-bold">{label}</div>
                          <div className="pt-1.5 border-t border-[var(--bark-800,#1b2620)] space-y-1 max-h-48 overflow-y-auto">
                            {tools.map((t) => {
                              const isChecked = draftTools.includes(t.name);
                              return (
                                <label
                                  key={t.name}
                                  className="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer hover:text-emerald-300 group"
                                >
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => toggleTool(t.name)}
                                    className="mt-0.5 rounded border-[var(--bark-700,#24332b)] bg-[var(--bark-900,#111814)] text-emerald-500 focus:ring-0"
                                  />
                                  <div className="min-w-0">
                                    <div className="font-mono truncate">{t.name}</div>
                                    {t.description && (
                                      <div className="text-[10px] text-slate-500 group-hover:text-slate-400 leading-snug line-clamp-2">
                                        {t.description}
                                      </div>
                                    )}
                                  </div>
                                </label>
                              );
                            })}
                          </div>
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