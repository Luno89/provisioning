import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Sliders, X, Check, Loader2, Sparkles, Wrench,
  Layers, Cpu, Globe, Server, Save
} from 'lucide-react';
import {
  listPersonas, getPersonaOptions, updatePersona,
  personaKeys
} from '../api/personas.js';
import { listPacks, updatePack, packKeys, type PersonaPack } from '../api/packs';
import type { Persona } from './PersonaEditor.js';
import { errorMessage } from '../api/client.js';

/**
 * ── WHAT THIS DRAWER EDITS, AND WHY IT CHANGED ──
 * It listed PERSONAS and called `onSelectPack(persona.id)` — a persona uuid handed to something
 * expecting a pack. `ChatSurface` put it straight into the `:packId` path segment, so clicking any
 * persona posted to a pack that did not exist while the header still read "Koala".
 *
 * The two are different things and the drawer now says so. A pack is what you SWITCH between and
 * what carries the runtime — its tools, its permissions, its sampling. The persona it points at
 * carries the prompt, which is edited here too because a prompt and the tools it talks about are
 * the same act of configuration.
 */

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

  // Queries
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

  const { data: options } = useQuery({
    queryKey: personaKeys.options(),
    queryFn: getPersonaOptions,
    enabled: isOpen,
  });

  /**
   * The selected pack, and the persona it names.
   *
   * No `?? packs[0]` fallback. That is precisely what made this drawer offer Framer's prompt under
   * Koala's name: asked for `koala`, finding no persona by that name because Koala was not seeded,
   * it silently showed the first record it had.
   */
  const currentPack = packs.find((p) => p.id === selectedId || p.slug === selectedId);
  const currentPersona = personas.find((p) => p.id === currentPack?.personaId);

  // Local Draft State
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftTemperature, setDraftTemperature] = useState<number>(0.7);
  const [draftTools, setDraftTools] = useState<string[]>([]);
  const [draftMcp, setDraftMcp] = useState<string[]>([]);
  const [draftMaxSteps, setDraftMaxSteps] = useState<number>(20);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Hydrate draft state when selected persona changes
  useEffect(() => {
    if (!currentPack) return;
    setDraftName(currentPack.name);
    setDraftDesc(currentPack.description ?? '');
    // The prompt belongs to the persona; everything else on this form belongs to the pack.
    setDraftPrompt(currentPersona?.systemPrompt ?? '');
    setDraftTemperature(
      typeof currentPack.overrides?.temperature === 'number' ? currentPack.overrides.temperature : 0.7,
    );
    setDraftTools(currentPack.tools ?? []);
    setDraftMcp(currentPersona?.scope?.mcp ?? []);
    setDraftMaxSteps(
      typeof currentPack.overrides?.maxSteps === 'number' ? currentPack.overrides.maxSteps : 20,
    );
    setStatusMsg(null);
  }, [currentPack, currentPersona]);

  /**
   * Two writes, because two records are being edited.
   *
   * The pack takes the runtime — its name, its tool grant, its sampling. The persona takes the
   * prompt. Sending the tools to the persona is what this form used to do, and it is why the
   * switches did nothing: a chat turn read its tools from the pack and never looked at the persona.
   */
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!currentPack) return;
      await updatePack(currentPack.id, {
        name: draftName,
        description: draftDesc,
        tools: draftTools,
        overrides: {
          ...(currentPack.overrides ?? {}),
          temperature: draftTemperature,
          maxSteps: draftMaxSteps,
        },
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

  const toggleMcp = (serverName: string) => {
    setDraftMcp((prev) =>
      prev.includes(serverName) ? prev.filter((s) => s !== serverName) : [...prev, serverName],
    );
  };

  // Built-in toolsets
  const toolCategories = [
    {
      id: 'proposals',
      name: 'Project & Spec Proposals',
      icon: Layers,
      tools: ['propose_tree', 'propose_spec', 'add_project_dependency'],
      description: 'Allows agent to propose structured projects and new container app specs.',
    },
    {
      id: 'k8s',
      name: 'Cluster & Diagnostics',
      icon: Cpu,
      tools: ['list_infrastructure', 'get_logs', 'get_events', 'inspect_resources', 'cluster_capacity', 'list_trees'],
      description: 'Allows reading pod logs, events, capacity, and live cluster state.',
    },
    {
      id: 'web',
      name: 'Web & Intelligence',
      icon: Globe,
      tools: ['web_search', 'fetch_web_page', 'list_mcp_servers', 'enable_mcp_server'],
      description: 'Web search, live webpage fetching, and dynamic MCP server discovery.',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150 font-sans">
      <div className="relative w-full max-w-4xl max-h-[90vh] bg-[var(--bark-900,#111814)] border border-[var(--bark-700,#24332b)] rounded-lg shadow-2xl flex flex-col overflow-hidden text-slate-200">
        {/* Header Bar */}
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

        {/* Main Content Grid */}
        <div className="flex-1 overflow-y-auto grid grid-cols-1 md:grid-cols-12 divide-y md:divide-y-0 md:divide-x divide-[var(--bark-800,#1b2620)]">
          {/* Left Column: Persona Selector */}
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
                      setSelectedId(p.slug);
                      // The SLUG, which is what the route carries. This passed `p.id` — a persona
                      // uuid — straight into the `:packId` path segment.
                      onSelectPack(p.slug);
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

          {/* Right Column: Editor & Tool Config */}
          <div className="md:col-span-8 p-5 space-y-5 bg-[var(--bark-900,#111814)]">
            {currentPack ? (
              <>
                {/* Identity & Prompt */}
                <div className="space-y-3.5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-semibold text-slate-300 block mb-1">
                        Persona Name
                      </label>
                      <input
                        type="text"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        className="w-full bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] focus:border-emerald-500/80 rounded-md px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-semibold text-slate-300 block mb-1 flex items-center justify-between">
                        <span>Sampling Temperature</span>
                        <span className="text-emerald-400 font-mono font-bold">{draftTemperature}</span>
                      </label>
                      <input
                        type="range"
                        min="0.0"
                        max="1.5"
                        step="0.05"
                        value={draftTemperature}
                        onChange={(e) => setDraftTemperature(parseFloat(e.target.value))}
                        className="w-full accent-emerald-500 mt-1 cursor-pointer"
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

                {/* Tool Enablement Matrix */}
                <div className="space-y-2.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
                    <Wrench size={13} className="text-emerald-400" />
                    <span>Enabled Capabilities & Tools</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {toolCategories.map((cat) => {
                      const Icon = cat.icon;

                      return (
                        <div
                          key={cat.id}
                          className="bg-[var(--bark-950,#090d0b)] border border-[var(--bark-800,#1b2620)] rounded-md p-3 space-y-2"
                        >
                          <div className="flex items-center gap-1.5 text-slate-200 text-xs font-bold">
                            <Icon size={13} className="text-emerald-400" />
                            <span>{cat.name}</span>
                          </div>
                          <div className="text-[11px] text-slate-400 leading-snug font-sans">{cat.description}</div>
                          <div className="pt-1.5 border-t border-[var(--bark-800,#1b2620)] space-y-1">
                            {cat.tools.map((t) => {
                              const isChecked = draftTools.length === 0 || draftTools.includes(t);
                              return (
                                <label
                                  key={t}
                                  className="flex items-center gap-2 text-[11px] font-mono text-slate-300 cursor-pointer hover:text-emerald-300"
                                >
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => toggleTool(t)}
                                    className="rounded border-[var(--bark-700,#24332b)] bg-[var(--bark-900,#111814)] text-emerald-500 focus:ring-0"
                                  />
                                  <span className="truncate">{t}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* MCP Attached Services */}
                <div className="space-y-2.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
                    <Server size={13} className="text-emerald-400" />
                    <span>Attached Cluster MCP Services</span>
                  </div>

                  {(options?.mcpServers?.length ?? 0) === 0 ? (
                    <div className="text-xs text-slate-400 bg-[var(--bark-950,#090d0b)] p-3 rounded-md border border-[var(--bark-800,#1b2620)] font-sans">
                      No standalone external MCP servers currently deployed. Agents will discover and attach deployed cluster services dynamically.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {(options?.mcpServers ?? []).map((srv) => {
                        const isAttached = draftMcp.includes(srv.name);
                        return (
                          <label
                            key={srv.name}
                            className={`flex items-center justify-between p-2.5 rounded-md border cursor-pointer text-xs transition-colors ${
                              isAttached
                                ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300'
                                : 'bg-[var(--bark-950,#090d0b)] border-[var(--bark-800,#1b2620)] text-slate-400 hover:border-slate-600'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={isAttached}
                                onChange={() => toggleMcp(srv.name)}
                                className="rounded border-[var(--bark-700,#24332b)] bg-[var(--bark-900,#111814)] text-emerald-500 focus:ring-0"
                              />
                              <span className="font-semibold">{srv.name}</span>
                            </div>
                            <span className="text-[10px] font-mono text-slate-500">[{srv.tools} tools]</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="text-center py-12 text-slate-500 text-xs font-sans">
                Select a pack from the list to view and configure how it runs.
              </div>
            )}
          </div>
        </div>

        {/* Bottom Action Footer */}
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
