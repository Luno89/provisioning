import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExpandableText } from './ExpandableText';
import { useMutation } from '@tanstack/react-query';
import { ChevronRight, ChevronDown } from 'lucide-react';
import {
  GROUP_LABEL, describeTunable,
  type EffectiveKnob, type Experiment, type HarnessProfile, type Tunable, errorMessage,
} from './shared';
import { updateExperiment } from '../../api/harness';
import { listPersonas } from '../../api/personas';

export function VariantPanel({ experiment, tunables, effective, prompts, profile, disabled, onSaved,
}: {
  experiment: Experiment;
  tunables: Tunable[];
  effective: EffectiveKnob[];
  prompts: Record<string, string>;
  profile: HarnessProfile | null;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const { data: personas } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['personas'],
    queryFn: listPersonas,
  });
  const [draft, setDraft] = useState<Record<string, Record<string, unknown>> | null>(null);
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () => updateExperiment(
      experiment.id,
      {
        variants: experiment.variants.map((v) => ({
          label: v.label,
          overrides: draft?.[v.label] ?? v.overrides,
          ...(personaFor(v.label) ? { personaId: personaFor(v.label) } : {}),
        })),
      },
    ),
    onSuccess: () => { setDraft(null); setPersonaDraft(null); setError(''); onSaved(); },
    onError: (err: unknown) => setError(errorMessage(err)),
  });

  const [personaDraft, setPersonaDraft] = useState<Record<string, string> | null>(null);
  const personaFor = (label: string) =>
    personaDraft?.[label] ?? experiment.variants.find((v) => v.label === label)?.personaId ?? '';

  const editing = draft !== null;
  const beginEdit = () => {
    setDraft(Object.fromEntries(experiment.variants.map((v) => [v.label, { ...v.overrides }])));
    setPersonaDraft(Object.fromEntries(experiment.variants.map((v) => [v.label, v.personaId ?? ''])));
    setError('');
  };
  const overridesFor = (label: string) =>
    (editing ? draft![label] : experiment.variants.find((v) => v.label === label)?.overrides) ?? {};

  const setValue = (label: string, key: string, value: unknown) =>
    setDraft((d) => {
      const next = { ...(d ?? {}) };
      const own = { ...(next[label] ?? {}) };
      if (value === undefined) delete own[key];
      else own[key] = value;
      next[label] = own;
      return next;
    });

  const field = 'bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2 py-1 text-[11px] text-slate-200 focus:border-[var(--leaf)] focus:outline-none';

  return (
    <div className="border-t border-[var(--bark-600)]">

      {(
        <div className="px-4 pb-3 space-y-2">
          {experiment.variants.map((v) => {
            const own = overridesFor(v.label);
            const prof = profile?.overrides ?? {};
            const inherited = Object.keys(prof).filter((k) => !(k in own) || own[k] === prof[k]);
            const isOpen = shown === v.label;
            const setKeys = Object.keys(own).filter((k) => !(k in prof && own[k] === prof[k]));

            return (
              <div key={v.label} className="bg-[var(--bark-900)]/50 rounded-lg p-2.5">
                <button
                  onClick={() => setShown(isOpen ? null : v.label)}
                  className="w-full flex items-center gap-2 text-left"
                >
                  {isOpen ? <ChevronDown size={11} className="text-slate-600" /> : <ChevronRight size={11} className="text-slate-600" />}
                  <span className="text-[12px] font-mono text-slate-300">{v.label}</span>
                  <span className="text-[11px] text-slate-600">
                    {setKeys.length ? setKeys.join(', ') : 'no overrides — harness default'}
                  </span>
                  {inherited.length > 0 && (
                    <span className="ml-auto text-[10px] text-amber-400">
                      {`inherits ${inherited.join(', ')} from adopted defaults`}
                    </span>
                  )}
                </button>

                {isOpen && (
                  <div className="mt-2 space-y-3">
                    {(personas?.length ?? 0) > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-slate-400 min-w-[150px]">runs as</span>
                        {editing ? (
                          <select
                            className={field}
                            value={personaFor(v.label)}
                            onChange={(e) => setPersonaDraft((d) => ({ ...(d ?? {}), [v.label]: e.target.value }))}
                          >
                            <option value="">— no persona —</option>
                            {(personas ?? []).map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-[10px] font-mono text-[var(--leaf-light)]">
                            {(personas ?? []).find((p) => p.id === personaFor(v.label))?.name ?? '—'}
                          </span>
                        )}
                        <span className="ml-auto text-[9px] text-slate-600">
                          resolved under this arm's own knobs
                        </span>
                      </div>
                    )}
                    {['prompt', 'sampling', 'loop'].map((group) => {
                      const rows = tunables.filter((t) => t.group === group);
                      if (!rows.length) return null;
                      return (
                        <div key={group}>
                          <p className="text-[9px] uppercase tracking-widest text-slate-600 mb-1">
                            {GROUP_LABEL[group] ?? group}
                          </p>
                          <div className="space-y-1.5">
                            {rows.map((t) => (
                              <KnobRow
                                key={t.key}
                                tunable={t}
                                value={own[t.key]}
                                fromProfile={(!(t.key in own) || own[t.key] === prof[t.key]) && t.key in prof}
                                profileValue={prof[t.key]}
                                fallbackText={t.promptId ? prompts[t.promptId] : undefined}
                                liveDefault={effective.find((e) => e.key === t.key)?.value}
                                editing={editing}
                                field={field}
                                onChange={(value) => setValue(v.label, t.key, value)}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}

                    {inherited.length > 0 && (
                      <p className="text-[10px] text-amber-400 leading-snug">
                        {`A promoted default supplies ${inherited.join(', ')} to this variant, so it is `
                          + 'not running the harness\'s built-in value. Clear it to opt out.'}
                      </p>
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
                onClick={() => { setDraft(null); setPersonaDraft(null); }}
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

function KnobRow({
  tunable: t, value, fromProfile, profileValue, fallbackText, liveDefault, editing, field, onChange,
}: {
  tunable: Tunable;
  value: unknown;
  fromProfile: boolean;
  profileValue: unknown;
  liveDefault?: unknown;
  fallbackText?: string | undefined;
  editing: boolean;
  field: string;
  onChange: (value: unknown) => void;
}) {
  const isSet = value !== undefined;
  const isProfileMatch = fromProfile || (profileValue !== undefined && value === profileValue);
  const isVariantOverride = isSet && !isProfileMatch;
  const effective = isSet ? value : fromProfile ? profileValue : (fallbackText ?? liveDefault ?? t.default);
  const source = isVariantOverride ? 'this variant' : isProfileMatch ? 'adopted default' : 'harness default';
  const tone = isVariantOverride ? 'text-amber-400' : isProfileMatch ? 'text-amber-400' : 'text-slate-600';
  const isProse = t.type === 'string' && String(effective ?? '').length > 60;

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span
          className="text-[10px] font-mono text-slate-400 min-w-[150px] cursor-help"
          title={describeTunable(t, liveDefault === undefined ? undefined : { value: liveDefault, source: 'harness' })}
        >
          {t.key}
        </span>
        {editing ? (
          t.choices ? (
            <select
              className={field}
              value={value === undefined ? '' : String(value)}
              onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
            >
              <option value="">
                {t.choices.length ? `— not set — uses the ${source}` : '— no models available —'}
              </option>
              {t.choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.note ? `${c.label} — ${c.note}` : c.label}
                </option>
              ))}
            </select>
          ) : t.type === 'boolean' ? (
            <select
              className={field}
              value={isSet ? String(value) : ''}
              onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}
            >
              <option value="">— not set —</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : t.type === 'number' ? (
            <input
              type="number"
              className={`${field} w-28`}
              min={t.min}
              max={t.max}
              step={t.step}
              value={isSet ? String(value) : ''}
              placeholder="not set"
              onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            />
          ) : (
            <div className="flex-1">
              <ExpandableText
                label={t.label}
                value={isSet ? String(value) : ''}
                rows={4}
                field={`${field} font-mono`}
                placeholder={`not set — uses the ${source}`}
                fallback={String(effective ?? '')}
                fallbackNote={source}
                onChange={(v) => onChange(v.trim() === '' ? undefined : v)}
              />
            </div>
          )
        ) : (
          !isProse && (
            <span className="text-[10px] font-mono text-[var(--leaf-light)] break-all">
              {t.choices?.find((c) => c.value === String(effective))?.label ?? String(effective ?? '—')}
            </span>
          )
        )}
        {!editing && <span className={`ml-auto text-[9px] ${tone}`}>{source}</span>}
      </div>

      {!editing && isProse && (
        <pre className="text-[10px] text-slate-400 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto bg-[var(--bark-900)]/70 rounded p-2 mt-1">
          {String(effective)}
        </pre>
      )}
      {t.note && !editing && isSet && (
        <p className="text-[9px] text-slate-600 leading-snug mt-0.5">{t.note}</p>
      )}
    </div>
  );
}
