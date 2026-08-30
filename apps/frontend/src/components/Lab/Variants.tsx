import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMutation } from '@tanstack/react-query';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { type Experiment, errorMessage } from './shared';
import { updateExperiment } from '../../api/harness';
import { listPacks } from '../../api/packs';

export function VariantPanel({ experiment, disabled, onSaved,
}: {
  experiment: Experiment;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const { data: packs } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['packs'],
    queryFn: listPacks,
  });
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () => updateExperiment(
      experiment.id,
      {
        variants: experiment.variants.map((v) => ({
          label: v.label,
          packId: personaFor(v.label) || v.packId,
        })),
      },
    ),
    onSuccess: () => { setPersonaDraft(null); setError(''); onSaved(); },
    onError: (err: unknown) => setError(errorMessage(err)),
  });

  const [personaDraft, setPersonaDraft] = useState<Record<string, string> | null>(null);
  const personaFor = (label: string) =>
    personaDraft?.[label] ?? experiment.variants.find((v) => v.label === label)?.packId ?? '';

  const editing = personaDraft !== null;
  const beginEdit = () => {
    setPersonaDraft(Object.fromEntries(experiment.variants.map((v) => [v.label, v.packId ?? ''])));
    setError('');
  };


  const field = 'bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2 py-1 text-[11px] text-slate-200 focus:border-[var(--leaf)] focus:outline-none';

  return (
    <div className="border-t border-[var(--bark-600)]">

      {(
        <div className="px-4 pb-3 space-y-2">
          {experiment.variants.map((v) => {
            const isOpen = shown === v.label;
            const packName = (packs ?? []).find((p) => p.id === personaFor(v.label))?.name;

            return (
              <div key={v.label} className="bg-[var(--bark-900)]/50 rounded-lg p-2.5">
                <button
                  onClick={() => setShown(isOpen ? null : v.label)}
                  className="w-full flex items-center gap-2 text-left"
                >
                  {isOpen ? <ChevronDown size={11} className="text-slate-600" /> : <ChevronRight size={11} className="text-slate-600" />}
                  <span className="text-[12px] font-mono text-slate-300">{v.label}</span>
                  <span className="text-[11px] text-slate-600">
                    {packName ? `runs as ${packName}` : 'names no pack'}
                  </span>
                </button>

                {isOpen && (
                  <div className="mt-2 space-y-3">
                    {(packs?.length ?? 0) > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-slate-400 min-w-[150px]">runs as</span>
                        {editing ? (
                          <select
                            className={field}
                            value={personaFor(v.label)}
                            onChange={(e) => setPersonaDraft((d) => ({ ...(d ?? {}), [v.label]: e.target.value }))}
                          >
                            <option value="">— no pack —</option>
                            {(packs ?? []).map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-[10px] font-mono text-[var(--leaf-light)]">
                            {(packs ?? []).find((p) => p.id === personaFor(v.label))?.name ?? '—'}
                          </span>
                        )}
                        <span className="ml-auto text-[9px] text-slate-600">
                          an arm IS a pack — change what it runs by changing that pack
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {error && <p className="text-[11px] text-red-400">{error}</p>}

          {editing ? (
            <div className="flex items-center gap-3">
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-50"
              >
                Save variants
              </button>
              <button
                onClick={() => setPersonaDraft(null)}
                className="text-[12px] text-slate-500 hover:text-slate-300"
              >
                Cancel
              </button>
              <span className="text-[11px] text-slate-500">
                Past runs are kept — each records the settings it actually ran under, so the next
                run answers the new question without erasing the old answer.
              </span>
            </div>
          ) : (
            <button
              onClick={beginEdit}
              disabled={disabled}
              title={disabled ? 'Wait for the run to finish' : 'Edit what each variant changes'}
              className="text-[12px] text-[var(--leaf-light)] hover:text-white disabled:opacity-40"
            >
              Edit variants
            </button>
          )}
        </div>
      )}
    </div>
  );
}

