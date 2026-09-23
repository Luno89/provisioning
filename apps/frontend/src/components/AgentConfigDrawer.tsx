import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sliders, X, Loader2, ExternalLink, Check } from 'lucide-react';
import { agentKeys, listAgents, type Agent } from '../api/agents';
import { listModels, providerKeys, type ModelProvider } from '../api/models';
import { modelOptionLabel } from '../lib/model-label';
import { useShellStore } from '../stores/shell.js';

/**
 * Drawer that picks which engine agent answers in a normal (non-branch) conversation, and shows
 * what that agent is allowed to do. The pick is applied straight away via `onSelectAgent` — the
 * conversation hook persists it to the conversation document, so the next turn runs on that agent.
 * Deep editing of an agent (prompt, procedure, grants) deliberately stays in the Studio; this
 * drawer only selects and explains.
 */
export function AgentConfigDrawer({
  isOpen,
  onClose,
  selectedAgentSlug,
  onSelectAgent,
}: {
  isOpen: boolean;
  onClose: () => void;
  selectedAgentSlug: string;
  onSelectAgent: (slug: string) => void;
}) {
  const qc = useQueryClient();
  const setShellView = useShellStore((s) => s.setView);
  const [draftSlug, setDraftSlug] = useState<string>(selectedAgentSlug);

  useEffect(() => {
    if (isOpen) setDraftSlug(selectedAgentSlug);
  }, [isOpen, selectedAgentSlug]);

  const { data: agents = [], isPending, isError, refetch } = useQuery<Agent[]>({
    queryKey: agentKeys.all,
    queryFn: listAgents,
    enabled: isOpen,
  });
  const { data: models = [] } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
    enabled: isOpen,
  });

  const currentAgent =
    agents.find((a) => a.slug === draftSlug)
    ?? agents.find((a) => a.slug === selectedAgentSlug);

  const agentModel = currentAgent?.model?.endpointId
    ? models.find((m) => m.id === currentAgent.model?.endpointId)
    : undefined;

  if (!isOpen) return null;

  const commit = () => {
    if (!currentAgent) return;
    onSelectAgent(currentAgent.slug);
    qc.invalidateQueries({ queryKey: agentKeys.all });
    onClose();
  };

  const envChips = currentAgent
    ? Object.entries({
        terminal: currentAgent.environment.terminal,
        filesystem: currentAgent.environment.filesystem,
        egress: currentAgent.environment.egress,
        git: currentAgent.environment.git,
        workspace: currentAgent.environment.workspace,
      })
        .filter(([, on]) => on)
        .map(([label]) => label)
        .concat(currentAgent.environment.languages ?? [])
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150 font-sans">
      <div className="relative w-full max-w-4xl max-h-[90vh] bg-[var(--bark-900,#111814)] border border-[var(--bark-700,#24332b)] rounded-lg shadow-2xl flex flex-col overflow-hidden text-slate-200">
        <div className="flex items-center justify-between px-5 py-3.5 bg-[var(--bark-950,#090d0b)] border-b border-[var(--bark-800,#1b2620)]">
          <div className="flex items-center gap-2">
            <div className="p-1 rounded bg-emerald-500/10 text-emerald-400">
              <Sliders size={15} />
            </div>
            <div>
              <h3 className="text-xs font-bold text-slate-100 uppercase tracking-wide">Agent &amp; Capabilities</h3>
              <p className="text-[11px] text-slate-400 font-sans">
                Pick which agent answers in this conversation, and see what it is allowed to do
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
              Agents ({agents.length})
            </div>

            {isPending && (
              <div className="flex items-center gap-1.5 text-[11px] text-slate-500 px-1 py-2">
                <Loader2 size={12} className="animate-spin" />
                Loading agents…
              </div>
            )}
            {isError && (
              <button
                type="button"
                onClick={() => refetch()}
                className="w-full text-left p-2 text-[11px] text-red-300 rounded-md border border-red-900/60 hover:bg-red-950/40 cursor-pointer"
              >
                Could not load agents — retry
              </button>
            )}

            <div className="space-y-1">
              {agents.map((a) => {
                const isSelected = a.slug === currentAgent?.slug;
                const isCurrent = a.slug === selectedAgentSlug;
                return (
                  <button
                    key={a.slug}
                    type="button"
                    onClick={() => setDraftSlug(a.slug)}
                    className={`w-full text-left p-2.5 rounded-md border transition-colors text-xs flex items-center justify-between cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--bark-800,#1b2620)] border-emerald-500/50 text-slate-100'
                        : 'bg-[var(--bark-900,#111814)] border-[var(--bark-800,#1b2620)] text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <div className="min-w-0 pr-2">
                      <div className="font-semibold flex items-center gap-1.5 truncate">
                        <span>{a.name}</span>
                        {a.mine && (
                          <span className="px-1 rounded bg-sky-950/80 border border-sky-500/40 text-[9px] font-mono text-sky-300 uppercase">
                            Yours
                          </span>
                        )}
                        {!a.mine && (
                          <span className="px-1 rounded bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] text-[9px] font-mono text-slate-400 uppercase">
                            seed
                          </span>
                        )}
                      </div>
                      {a.description && (
                        <div className="text-[11px] text-slate-400 truncate mt-0.5 font-sans">
                          {a.description}
                        </div>
                      )}
                    </div>
                    {isCurrent && (
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
            {currentAgent ? (
              <>
                <div className="space-y-3.5">
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-bold text-slate-100">{currentAgent.name}</h4>
                      <span className="px-1.5 py-0.5 rounded bg-[var(--bark-950,#090d0b)] border border-[var(--bark-800,#1b2620)] text-[10px] font-mono text-slate-500">
                        {currentAgent.slug}
                      </span>
                    </div>
                    {currentAgent.description && (
                      <p className="text-xs text-slate-300 mt-1 leading-relaxed font-sans">{currentAgent.description}</p>
                    )}
                  </div>

                  <div className="text-xs text-slate-300">
                    <span className="text-slate-400">Model</span>{' '}
                    {agentModel
                      ? <span className="font-mono text-slate-200">{modelOptionLabel(agentModel)}</span>
                      : <span className="text-slate-400">follows this conversation's model pick</span>}
                    {currentAgent.model?.reasoningEffort && (
                      <span className="ml-2 text-[10px] text-slate-500 font-mono">effort: {currentAgent.model.reasoningEffort}</span>
                    )}
                    {typeof currentAgent.model?.replyCeiling === 'number' && (
                      <span className="ml-2 text-[10px] text-slate-500 font-mono">reply ceiling: {currentAgent.model.replyCeiling}</span>
                    )}
                  </div>
                </div>

                <div className="space-y-2.5">
                  <div className="text-xs font-bold text-slate-200">Capabilities</div>
                  {currentAgent.tools.length === 0 ? (
                    <p className="text-[11px] text-slate-500">No tools granted — pure conversation only.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {currentAgent.tools.map((t) => (
                        <span
                          key={t}
                          className="px-2 py-0.5 rounded-md bg-[var(--bark-950,#090d0b)] border border-[var(--bark-700,#24332b)] text-[11px] font-mono text-slate-300"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  {envChips.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {envChips.map((c) => (
                        <span
                          key={c}
                          className="px-1.5 py-0.5 rounded bg-[var(--bark-950,#090d0b)] border border-[var(--bark-800,#1b2620)] text-[10px] font-mono text-slate-400"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-slate-500 pt-1">
                    Grants and workspace are managed in the Studio — <button type="button" className="text-emerald-400 underline decoration-emerald-500/40 hover:text-emerald-300 cursor-pointer" onClick={() => setShellView('studio')}>open the Studio</button> to change them.
                  </p>
                </div>

                {currentAgent.guidance && (
                  <details className="rounded-md border border-[var(--bark-800,#1b2620)] bg-[var(--bark-950,#090d0b)]/60">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-300 select-none">
                      Guidance
                    </summary>
                    <pre className="px-3 pb-3 text-[11px] text-slate-400 whitespace-pre-wrap font-sans leading-relaxed max-h-56 overflow-y-auto">{currentAgent.guidance}</pre>
                  </details>
                )}

                {currentAgent.procedure && (
                  <details className="rounded-md border border-[var(--bark-800,#1b2620)] bg-[var(--bark-950,#090d0b)]/60">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-300 select-none">
                      Procedure
                    </summary>
                    <pre className="px-3 pb-3 text-[11px] text-slate-400 whitespace-pre-wrap font-mono leading-relaxed max-h-56 overflow-y-auto">{currentAgent.procedure}</pre>
                  </details>
                )}
              </>
            ) : (
              <div className="text-center py-12 text-slate-500 text-xs font-sans">
                Select an agent from the list to see how it runs in this conversation.
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-3 bg-[var(--bark-950,#090d0b)] border-t border-[var(--bark-800,#1b2620)]">
          <div />

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShellView('studio')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--bark-700,#24332b)] hover:bg-[var(--bark-800,#1b2620)] text-slate-300 text-xs transition-colors cursor-pointer"
            >
              <ExternalLink size={13} />
              <span>Open in Studio</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md border border-[var(--bark-700,#24332b)] hover:bg-[var(--bark-800,#1b2620)] text-slate-300 text-xs transition-colors cursor-pointer"
            >
              Close
            </button>

            {currentAgent && currentAgent.slug !== selectedAgentSlug && (
              <button
                type="button"
                onClick={commit}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-emerald-500/60 bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 text-xs font-medium transition-colors cursor-pointer"
              >
                <Check size={13} />
                <span>Use this agent</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default AgentConfigDrawer;