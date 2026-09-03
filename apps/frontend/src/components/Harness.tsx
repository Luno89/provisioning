import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sliders, ChevronRight, ChevronDown, Download, Upload } from 'lucide-react';
import { card, describeValue, describeTunable, errorMessage } from '../lib/pack-editor.js';
import type { HarnessConfig, HarnessProfile } from '@koala/harness-types';
import { ProfileBanner } from './ProfileBanner.js';
import { TreeTypeRoles } from './TreeTypeRoles.js';
import { DefaultModelPicker } from './DefaultModelPicker.js';
import {
  getConfig, getProfile, profileKeys, importHarnessConfig,
  harnessExportUrl,
} from '../api/harness';

export function Harness() {
  const qc = useQueryClient();
  const [openSection, setOpenSection] = useState<string | null>('agent');
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
  const [showKnobs, setShowKnobs] = useState(false);
  const [importNote, setImportNote] = useState('');

  const { data: config } = useQuery<HarnessConfig>({
    queryKey: profileKeys.config(),
    queryFn: getConfig,
  });
  const { data: profile } = useQuery<HarnessProfile | null>({
    queryKey: profileKeys.profile(),
    queryFn: getProfile,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: profileKeys.profile() });
    qc.invalidateQueries({ queryKey: profileKeys.config() });
  };

  const doImport = useMutation({
    mutationFn: (doc: unknown) =>
      importHarnessConfig(doc),
    onSuccess: (d: { created?: string[]; failed?: string[]; rejected?: string[] }) => {
      setImportNote(
        `Imported ${d.created?.length ?? 0}.`
        + (d.failed?.length ? ` Refused: ${d.failed.join('; ')}` : '')
        + (d.rejected?.length ? ` Skipped: ${d.rejected.join('; ')}` : ''),
      );
      invalidate();
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

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3 mb-1">
        <Sliders className="text-[var(--leaf-light)]" size={26} />
        <h2 className="text-3xl font-bold">Harness</h2>
      </div>
      <p className="text-slate-500 text-sm -mt-4">
        Platform-wide defaults: which pack the account runs as, the default model, and which pack
        fills each role for a project type.
      </p>

      <ProfileBanner profile={profile ?? null} onChanged={invalidate} />

      <section>
        <DefaultModelPicker />
      </section>

      <TreeTypeRoles />

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

      <section>
        <h3 className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Config file</h3>
        <div className={`${card} p-4`}>
          <p className="text-[11px] text-slate-500 mb-3">
            Suite definitions and adopted defaults as JSON — the questions, not the answers.
          </p>
          <div className="flex items-center gap-3">
            <a
              href={harnessExportUrl()}
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

export default Harness;
