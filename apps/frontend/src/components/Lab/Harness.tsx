/**
 * What the harness is set to — everything that shapes a run, in one place.
 *
 * Grouped by what a value IS rather than where it lives in the code: adopted first because it is
 * the layer that overrides everything else and the one most likely to surprise you, then the
 * interactive settings editor, then built-in settings, then prompts, and the registry of knobs.
 */
import { useState, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import axios from 'axios';
import { ChevronRight, ChevronDown, Download, Upload, Save, RefreshCw, CheckCircle2, Sliders } from 'lucide-react';
import { card, describeValue, describeTunable, type HarnessConfig, type HarnessProfile, errorMessage } from './shared';
import { ProfileBanner } from './Promote';
import { Personas } from './Personas';

export function Harness({
  apiBase, config, profile, onProfileChanged, onImported,
}: {
  apiBase: string;
  config: HarnessConfig | undefined;
  profile: HarnessProfile | null;
  onProfileChanged: () => void;
  onImported: () => void;
}) {
  const [openSection, setOpenSection] = useState<string | null>('agent');
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
  const [showKnobs, setShowKnobs] = useState(false);
  const [importNote, setImportNote] = useState('');
  const [overrides, setOverrides] = useState<Record<string, any>>({});
  const [statusNote, setStatusNote] = useState<string | null>(null);

  useEffect(() => {
    if (profile?.overrides) {
      setOverrides({ ...profile.overrides });
    } else {
      setOverrides({});
    }
  }, [profile]);

  const saveProfile = useMutation({
    mutationFn: (newOverrides: Record<string, any>) =>
      axios.put(`${apiBase}/harness/profile`, { overrides: newOverrides }, { withCredentials: true }).then((r) => r.data),
    onSuccess: () => {
      setStatusNote('Harness settings saved successfully!');
      onProfileChanged();
      setTimeout(() => setStatusNote(null), 4000);
    },
    onError: (err: unknown) => setStatusNote(errorMessage(err)),
  });

  const resetProfile = useMutation({
    mutationFn: () =>
      axios.delete(`${apiBase}/harness/profile`, { withCredentials: true }).then((r) => r.data),
    onSuccess: () => {
      setOverrides({});
      setStatusNote('Harness reset to factory defaults.');
      onProfileChanged();
      setTimeout(() => setStatusNote(null), 4000);
    },
    onError: (err: unknown) => setStatusNote(errorMessage(err)),
  });

  const doImport = useMutation({
    mutationFn: (doc: unknown) =>
      axios.post(`${apiBase}/harness/import`, doc, { withCredentials: true }).then((r) => r.data),
    onSuccess: (d: { created?: string[]; failed?: string[]; rejected?: string[] }) => {
      setImportNote(
        `Imported ${d.created?.length ?? 0}.`
        + (d.failed?.length ? ` Refused: ${d.failed.join('; ')}` : '')
        + (d.rejected?.length ? ` Skipped: ${d.rejected.join('; ')}` : ''),
      );
      onImported();
    },
    onError: (err: unknown) => setImportNote(errorMessage(err)),
  });

  const onFile = async (file: File) => {
    try {
      doImport.mutate(JSON.parse(await file.text()));
    } catch {
      setImportNote('That file is not JSON.');
    }
  };

  const setKnobValue = (key: string, val: any) => {
    setOverrides((prev) => {
      if (val === undefined || val === '') {
        const copy = { ...prev };
        delete copy[key];
        return copy;
      }
      return { ...prev, [key]: val };
    });
  };

  return (
    <div className="space-y-6">
      <ProfileBanner apiBase={apiBase} profile={profile} onChanged={onProfileChanged} />

      {/* ── Interactive Settings Editor ── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[10px] uppercase tracking-widest text-slate-500 flex items-center gap-1.5 font-bold">
            <Sliders size={12} className="text-[var(--leaf)]" /> Interactive Harness Controls
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => resetProfile.mutate()}
              disabled={resetProfile.isPending}
              className="px-2.5 py-1 rounded-lg border border-[var(--bark-600)] hover:bg-[var(--bark-700)] text-xs text-slate-400 flex items-center gap-1 transition-colors"
            >
              <RefreshCw size={12} /> Reset to Defaults
            </button>
            <button
              onClick={() => saveProfile.mutate(overrides)}
              disabled={saveProfile.isPending}
              className="px-3 py-1 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-xs text-white flex items-center gap-1.5 font-medium transition-colors"
            >
              <Save size={12} /> Save Overrides
            </button>
          </div>
        </div>

        {statusNote && (
          <div className="mb-3 p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />
            <span>{statusNote}</span>
          </div>
        )}

        <div className={`${card} p-4 space-y-4`}>
          <p className="text-xs text-slate-400 leading-relaxed">
            Modify any harness parameter directly below. Changes saved here become active defaults across all chat sessions and experiment runs.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            {(config?.tunables ?? []).map((t) => {
              const currentValue = overrides[t.key] !== undefined ? overrides[t.key] : (config?.effective?.find((e) => e.key === t.key)?.value ?? t.default);
              const isOverridden = overrides[t.key] !== undefined;

              return (
                <div key={t.key} className="bg-[var(--bark-900)] border border-[var(--bark-700)] rounded-xl p-3 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-200">{t.label} (Override)</span>
                    <span className="font-mono text-[10px] text-slate-500">{t.key}</span>
                  </div>

                  {t.type === 'number' && (
                    <div className="flex items-center gap-2">
                      {t.min !== undefined && t.max !== undefined ? (
                        <input
                          type="range"
                          min={t.min}
                          max={t.max}
                          step={t.step ?? 0.05}
                          value={currentValue ?? t.min}
                          onChange={(e) => setKnobValue(t.key, Number(e.target.value))}
                          className="flex-1 accent-[var(--leaf)] cursor-pointer"
                        />
                      ) : null}
                      <input
                        type="number"
                        step={t.step ?? 0.05}
                        value={currentValue ?? ''}
                        onChange={(e) => setKnobValue(t.key, e.target.value === '' ? undefined : Number(e.target.value))}
                        className="w-24 bg-[var(--bark-800)] border border-[var(--bark-600)] rounded px-2 py-1 text-slate-200 font-mono text-xs"
                      />
                    </div>
                  )}

                  {t.type === 'boolean' && (
                    <select
                      value={currentValue ? 'true' : 'false'}
                      onChange={(e) => setKnobValue(t.key, e.target.value === 'true')}
                      className="w-full bg-[var(--bark-800)] border border-[var(--bark-600)] rounded px-2.5 py-1 text-slate-200 text-xs"
                    >
                      <option value="true">True (Enabled)</option>
                      <option value="false">False (Disabled)</option>
                    </select>
                  )}

                  {t.type === 'enum' && t.options && (
                    <select
                      value={currentValue ?? ''}
                      onChange={(e) => setKnobValue(t.key, e.target.value)}
                      className="w-full bg-[var(--bark-800)] border border-[var(--bark-600)] rounded px-2.5 py-1 text-slate-200 text-xs"
                    >
                      {t.options.map((opt: any) => (
                        <option key={String(opt)} value={String(opt)}>{String(opt)}</option>
                      ))}
                    </select>
                  )}

                  {t.type === 'string' && !t.options && (
                    <input
                      type="text"
                      value={currentValue ?? ''}
                      onChange={(e) => setKnobValue(t.key, e.target.value)}
                      className="w-full bg-[var(--bark-800)] border border-[var(--bark-600)] rounded px-2.5 py-1 text-slate-200 text-xs"
                      placeholder={`Default: ${describeValue(t.default)}`}
                    />
                  )}

                  <div className="flex items-center justify-between text-[10px] text-slate-500 pt-1">
                    <span>{t.note || t.group}</span>
                    {isOverridden && <span className="text-[var(--leaf-light)] font-mono">modified</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── the configurations you can choose between, above the one everybody gets ── */}
      <Personas apiBase={apiBase} config={config} />

      {/* ── built-in settings, each with the failure that set it ── */}
      <section>
        <h3 className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Settings</h3>
        <div className="space-y-2">
          {config?.sections.map((section) => {
            const open = openSection === section.id;
            return (
              <div key={section.id} className={card}>
                <button
                  onClick={() => setOpenSection(open ? null : section.id)}
                  className="w-full flex items-center gap-2 px-4 py-3 text-left"
                >
                  {open ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
                  <span className="font-semibold text-slate-200">{section.title}</span>
                  <span className="text-[12px] text-slate-500 truncate">{section.summary}</span>
                </button>
                {open && (
                  <div className="px-4 pb-4 space-y-3 border-t border-[var(--bark-600)] pt-3">
                    {section.settings.map((s) => (
                      <div key={s.label} className="grid grid-cols-[minmax(0,180px)_1fr] gap-3">
                        <div className="text-[12px] text-slate-500">{s.label}</div>
                        <div className="min-w-0">
                          <code className="text-[12px] text-[var(--leaf-light)] break-words">{s.value}</code>
                          {s.note && <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{s.note}</p>}
                          <p className="text-[10px] text-slate-600 mt-1 font-mono">{s.source}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── every prompt the harness sends, verbatim ── */}
      <section>
        <h3 className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
          Prompts ({config?.prompts.length ?? 0})
        </h3>
        <div className="space-y-2">
          {config?.prompts.map((p) => (
            <div key={p.id} className={card}>
              <button
                onClick={() => setOpenPrompt(openPrompt === p.id ? null : p.id)}
                className="w-full flex items-center gap-2 px-4 py-3 text-left"
              >
                {openPrompt === p.id ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
                <span className="font-semibold text-slate-200">{p.title}</span>
                <span className="ml-auto text-[10px] text-slate-600">{p.text.length} chars</span>
              </button>
              {openPrompt === p.id && (
                <pre className="px-4 pb-4 text-[11px] text-slate-400 whitespace-pre-wrap leading-relaxed border-t border-[var(--bark-600)] pt-3 overflow-x-auto">
                  {p.text}
                </pre>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── the registry: what an experiment is able to vary at all ── */}
      <section>
        <button
          onClick={() => setShowKnobs((s) => !s)}
          className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-500 hover:text-slate-300 mb-2"
        >
          {showKnobs ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Knobs ({config?.tunables.length ?? 0})
        </button>
        {showKnobs && (
          <div className={`${card} p-4 overflow-x-auto`}>
            <table className="w-full text-[11px]">
              <tbody>
                {config?.tunables.map((t) => (
                  <tr
                    key={t.key}
                    className="border-t border-[var(--bark-700)] first:border-0"
                    title={describeTunable(t, config?.effective?.find((e) => e.key === t.key))}
                  >
                    <td className="py-1 pr-3 font-mono text-slate-300 align-top cursor-help">{t.key}</td>
                    <td className="py-1 pr-3 text-slate-600 align-top">{t.group}</td>
                    <td className="py-1 pr-3 font-mono text-[var(--leaf-light)] align-top">
                      {describeValue(t.default)}
                    </td>
                    <td className="py-1 pr-3 text-slate-600 align-top whitespace-nowrap">
                      {t.min !== undefined || t.max !== undefined ? `${t.min ?? ''}–${t.max ?? ''}` : ''}
                      {t.engine && <span className="ml-1 text-amber-400">{t.engine}</span>}
                    </td>
                    <td className="py-1 text-slate-600 align-top">{t.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── the committable artifact ── */}
      <section>
        <h3 className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Config file</h3>
        <div className={`${card} p-4`}>
          <p className="text-[11px] text-slate-500 mb-3">
            Suite definitions and adopted defaults as JSON — the questions, not the answers.
          </p>
          <div className="flex items-center gap-3">
            <a
              href={`${apiBase}/harness/export`}
              download="koala-harness.json"
              className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white"
            >
              <Download size={13} /> Export
            </a>
            <label className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg border border-[var(--bark-600)] text-slate-400 hover:bg-[var(--bark-700)] cursor-pointer">
              <Upload size={13} /> Import
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
              />
            </label>
            {importNote && <span className="text-[11px] text-slate-400">{importNote}</span>}
          </div>
        </div>
      </section>
    </div>
  );
}
