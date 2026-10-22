import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Cpu } from 'lucide-react';
import {
  listModels, providerKeys, useDefaultModel, setDefaultModel, setGlobalModelOverride,
  defaultModelKeys, type ModelProvider,
} from '../../api/models';
import { modelOptionLabel } from '../../lib/model-label';
import { ModelPicker } from '../ModelPicker';
import { errorMessage } from '../../api/client';
import { useMachineChoiceLabel } from '../../api/local-agents';
import { useShellStore } from '../../features/platform';

export function DefaultModelPicker() {
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const setView = useShellStore((s) => s.setView);

  const { data: models = [] } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
  });
  const { data: setting } = useDefaultModel();
  const currentId = setting?.defaultModelId ?? null;
  const overrides = setting?.globalModelOverride ?? false;

  const save = useMutation({
    mutationFn: (id: string | null) => setDefaultModel(id),
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: defaultModelKeys.current() });
      setNote(id ? 'Default model saved.' : 'Default cleared.');
      setTimeout(() => setNote(null), 4000);
    },
    onError: (err: unknown) => setNote(errorMessage(err)),
  });

  const toggleOverride = useMutation({
    mutationFn: (next: boolean) => setGlobalModelOverride(next),
    onSuccess: (next) => {
      qc.invalidateQueries({ queryKey: defaultModelKeys.current() });
      setNote(next
        ? 'Every agent now runs on the default.'
        : 'Agents are back on the models they name.');
      setTimeout(() => setNote(null), 4000);
    },
    onError: (err: unknown) => setNote(errorMessage(err)),
  });

  const current = models.find((m) => m.id === currentId);
  const machine = useMachineChoiceLabel(currentId);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
        <Cpu size={13} className="text-emerald-400" />
        <span>Default model</span>
      </div>
      <p className="text-[11px] text-slate-500">
        What every agent runs on unless it names a model of its own. Changing this moves all of them
        at once.
      </p>

      <div className="text-[11px] text-slate-400">
        Currently:{' '}
        {current
          ? <span className="font-mono text-emerald-300">{modelOptionLabel(current)}</span>
          : machine
            ? <span className="font-mono text-amber-200">{machine}<span className="font-sans text-slate-500"> — chats and the agents that can hand their work to a machine run on it; checks and the bench still need a model</span></span>
          : currentId
            ? <span className="text-amber-400">{currentId} — no longer in your list</span>
            : <span className="text-amber-400/80">not set — agents naming no model will fail</span>}
      </div>

      <div className="flex items-start justify-between gap-3 p-2.5 rounded-md bg-[var(--bark-950,#090d0b)] border border-[var(--bark-800,#1b2620)]">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-slate-200">Override every agent</div>
          <p className="text-[10px] text-slate-500 leading-snug mt-0.5">
            {overrides
              ? 'On — every agent runs on the default, whatever model it names. Turning this off puts each agent back on its own.'
              : 'Off — an agent that names its own model keeps it, and the default only fills in for agents that name none.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={overrides}
          aria-label="Override every agent with the default model"
          onClick={() => toggleOverride.mutate(!overrides)}
          disabled={toggleOverride.isPending}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            overrides ? 'bg-emerald-600' : 'bg-[var(--bark-700,#24332b)]'
          }`}
        >
          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            overrides ? 'translate-x-5' : 'translate-x-1'
          }`} />
        </button>
      </div>

      <ModelPicker
        models={models}
        selectedId={currentId}
        defaultModelId={currentId}
        onConfigure={() => document.getElementById('model-providers')?.scrollIntoView({ block: 'start' })}
        onSelect={(id) => save.mutate(id)}
        machines={{ onManage: () => setView('mesh') }}
      />

      {currentId && (
        <button
          type="button"
          onClick={() => save.mutate(null)}
          className="text-[10px] text-slate-500 hover:text-slate-300 underline"
        >
          Clear the default
        </button>
      )}

      {note && <p className="text-[11px] text-emerald-400">{note}</p>}
    </div>
  );
}
