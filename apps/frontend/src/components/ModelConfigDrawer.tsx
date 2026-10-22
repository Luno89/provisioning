import { useQuery } from '@tanstack/react-query';
import { Cpu, X, ExternalLink } from 'lucide-react';
import {
  listModels, providerKeys, useDefaultModel, type ModelProvider,
} from '../api/models';
import { modelOptionLabel } from '../lib/model-label';
import { useShellStore } from '../features/platform';
import { useMachineChoiceLabel } from '../features/machines';
import { ModelPicker } from './ModelPicker';
import type { ModelReach } from '@koala/harness-types';

const REACHES: { reach: ModelReach; label: string; detail: string }[] = [
  { reach: 'handoffs', label: 'This chat and the agents it hands work to', detail: 'Research, planning and the rest run on it too. An agent that cannot work on a machine, or one set to run somewhere of its own, keeps its own.' },
  { reach: 'chat', label: 'This chat only', detail: 'The agents it hands work to stay on their own models.' },
];

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
  reach,
  onReach,
}: {
  isOpen: boolean;
  onClose: () => void;
  selectedModelId: string | null;
  onSelectModel: (modelId: string | null) => void;
  reach: ModelReach;
  onReach: (reach: ModelReach) => void;
}) {
  const { data: models = [] } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
    enabled: isOpen,
  });

  const { data: setting } = useDefaultModel();
  const defaultModelId = setting?.defaultModelId ?? null;
  const setView = useShellStore((s) => s.setView);
  const machineLabel = useMachineChoiceLabel(selectedModelId);
  const defaultMachine = useMachineChoiceLabel(defaultModelId);

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
            {machineLabel
              ? <span className="font-mono text-amber-200">{machineLabel}<span className="text-slate-500 font-sans"> (its own loop, tools and model)</span></span>
              : selected
              ? <span className="font-mono text-emerald-300">{modelOptionLabel(selected)}</span>
              : defaultModel || defaultMachine
                ? <span className="font-mono text-emerald-300">{defaultModel ? modelOptionLabel(defaultModel) : defaultMachine}<span className="text-slate-500 font-sans"> (account default)</span></span>
                : <span className="text-amber-400">no account default set — pick one below</span>}
          </div>

          {selectedModelId && (
            <fieldset className="space-y-1.5">
              <legend className="text-[11px] text-slate-400 mb-1">Use it for</legend>
              {REACHES.map((option) => (
                <label
                  key={option.reach}
                  className={`flex items-start gap-2 rounded-md border px-2.5 py-2 cursor-pointer transition-colors ${reach === option.reach ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-[var(--bark-800,#1b2620)] hover:border-[var(--bark-700,#24332b)]'}`}
                >
                  <input
                    type="radio"
                    name="model-reach"
                    className="mt-0.5 accent-emerald-500"
                    checked={reach === option.reach}
                    onChange={() => onReach(option.reach)}
                  />
                  <span>
                    <span className="block text-xs text-slate-200">{option.label}</span>
                    <span className="block text-[10px] text-slate-500 leading-snug">{option.detail}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          <ModelPicker
            autoFocus
            models={models}
            selectedId={selectedModelId}
            defaultModelId={defaultModelId}
            onConfigure={() => { onClose(); setView('studio', ['models']); }}
            machines={{ onManage: () => { onClose(); setView('mesh'); } }}
            onSelect={(id) => { onSelectModel(id); onClose(); }}
            inheritOption={{
              label: defaultModel || defaultMachine
                ? `Follow the account default (${defaultModel ? modelOptionLabel(defaultModel) : defaultMachine})`
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
