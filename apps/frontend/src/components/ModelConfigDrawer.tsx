import { useQuery } from '@tanstack/react-query';
import { Cpu, X, ExternalLink } from 'lucide-react';
import {
  listModels, providerKeys, useDefaultModel, type ModelProvider,
} from '../api/models';
import { modelOptionLabel } from '../lib/model-label';
import { useShellStore } from '../stores/shell';
import { ModelPicker } from './ModelPicker';

/**
 * Which engine this conversation runs on.
 *
 * A sibling of PersonaConfigDrawer rather than a section inside it: WHO answers and WHAT it runs
 * on are chosen independently, and burying the model under a persona editor is what left the
 * composer's model control unwired for as long as it was.
 *
 * Choosing nothing here is a real choice — the conversation follows the account default, so
 * switching provider globally moves it too.
 */
export function ModelConfigDrawer({
  isOpen,
  onClose,
  selectedModelId,
  onSelectModel,
}: {
  isOpen: boolean;
  onClose: () => void;
  selectedModelId: string | null;
  onSelectModel: (modelId: string | null) => void;
}) {
  const { data: models = [] } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
    enabled: isOpen,
  });

  const { data: setting } = useDefaultModel();
  const defaultModelId = setting?.defaultModelId ?? null;
  const setView = useShellStore((s) => s.setView);

  if (!isOpen) return null;

  const defaultModel = models.find((m) => m.id === defaultModelId);
  const selected = models.find((m) => m.id === selectedModelId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150 font-sans">
      <div className="relative w-full max-w-lg max-h-[90vh] bg-[var(--bark-900,#111814)] border border-[var(--bark-700,#24332b)] rounded-lg shadow-2xl flex flex-col overflow-hidden text-slate-200">
        <div className="flex items-center justify-between px-5 py-3.5 bg-[var(--bark-950,#090d0b)] border-b border-[var(--bark-800,#1b2620)]">
          <div className="flex items-center gap-2">
            <div className="p-1 rounded bg-emerald-500/10 text-emerald-400">
              <Cpu size={15} />
            </div>
            <div>
              <h3 className="text-xs font-bold text-slate-100 uppercase tracking-wide">Model</h3>
              <p className="text-[11px] text-slate-400 font-sans">
                What this conversation runs on
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close model picker"
            className="p-1 text-slate-400 hover:text-slate-100 hover:bg-[var(--bark-800,#1b2620)] rounded-md transition-colors cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="text-[11px] text-slate-400">
            Using:{' '}
            {selected
              ? <span className="font-mono text-emerald-300">{modelOptionLabel(selected)}</span>
              : defaultModel
                ? <span className="font-mono text-emerald-300">{modelOptionLabel(defaultModel)}<span className="text-slate-500 font-sans"> (account default)</span></span>
                : <span className="text-amber-400">no account default set — pick one below</span>}
          </div>

          <ModelPicker
            autoFocus
            models={models}
            selectedId={selectedModelId}
            defaultModelId={defaultModelId}
            onConfigure={() => { onClose(); setView('accounts'); }}
            onSelect={(id) => { onSelectModel(id); onClose(); }}
            inheritOption={{
              label: defaultModel
                ? `Follow the account default (${modelOptionLabel(defaultModel)})`
                : 'Follow the account default — none set',
              onSelect: () => { onSelectModel(null); onClose(); },
            }}
          />

          <p className="text-[10px] text-slate-500 leading-snug border-t border-[var(--bark-800,#1b2620)] pt-2.5 flex items-start gap-1.5">
            <ExternalLink size={11} className="mt-0.5 shrink-0" />
            <span>
              Set the account default under Lab → Harness. Every pack that names no engine of its
              own follows it, so changing it there moves them all at once.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

export default ModelConfigDrawer;
