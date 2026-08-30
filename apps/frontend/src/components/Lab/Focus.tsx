import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Play, Award, Loader2 } from 'lucide-react';
import { Terminal } from './Terminal';
import { ExpandableText, EditorHost } from './ExpandableText';
import { TaskChat } from './TaskChat';
import { PromoteConfirm } from './Promote';
import { OutputPane } from './Output';
import type { LiveRun } from './Live';
import {
  useExperimentDetail, errorMessage, describeTunable, useEditorSlot, EditorSlot, packValueAt,
  type ExperimentTask, type HarnessConfig, type TaskFile, type VariantResult,
} from './shared';
import { updateExperiment, runExperiment, validateAuthored } from '../../api/harness';
import { listPacks } from '../../api/packs';

const showRaw = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export function Focus({ experimentId, config, live, onClose, onSaved,
}: {
  experimentId: string;
  config: HarnessConfig | undefined;
  live: LiveRun | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: exp } = useExperimentDetail(experimentId, true);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExperimentTask[] | null>(null);

  const [note, setNote] = useState('');
  const [pane, setPane] = useState<'prompt' | 'options' | 'chat'>('prompt');
  const [promoting, setPromoting] = useState(false);
  const { slot, request } = useEditorSlot();
  const qc = useQueryClient();

  const refresh = () => qc.invalidateQueries({ queryKey: ['experiment', experimentId] });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { data: packs } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['packs'],
    queryFn: listPacks,
  });

  const tasks = draft ?? exp?.tasks ?? [];
  const task = tasks.find((t) => t.id === taskId) ?? tasks[0];
  const variant = exp?.variants.find((v) => v.label === label) ?? exp?.variants[0];
  /**
   * An arm's values live on the pack it runs as, so this pane reads that pack rather than a bag of
   * overrides. It is read-only here: changing what an arm runs means changing its pack.
   */
  const armPack = (packs ?? []).find((p) => p.id === variant?.packId);
  const own = Object.fromEntries((config?.tunables ?? [])
    .map((t) => [t.key, packValueAt(armPack, t.path)])
    .filter(([, v]) => v !== undefined));
  const dirty = draft !== null;
  const running = Boolean(exp?.running) || exp?.status === 'running';
  const hasResults = (exp?.results ?? []).some((r) => r.label === variant?.label);

  const patchTask = (patch: Partial<ExperimentTask>) =>
    setDraft((prev) => (prev ?? exp?.tasks ?? []).map((t) => (t.id === task?.id ? { ...t, ...patch } : t)));

  const patchFiles = (key: 'seed' | 'solution', update: (files: TaskFile[]) => TaskFile[]) =>
    setDraft((prev) => (prev ?? exp?.tasks ?? []).map((t) => (
      t.id === task?.id ? { ...t, [key]: update(t[key] ?? []) } : t)));

  const save = useMutation({
    mutationFn: () => updateExperiment(
      experimentId,
      {
        tasks,
        variants: (exp?.variants ?? []).map((v) =>
          (v.label === variant?.label ? { label: v.label, overrides: own } : v)),
      },
    ),
    onSuccess: () => { setNote('Saved.'); setDraft(null); refresh(); onSaved(); },
    onError: (err: unknown) => setNote(errorMessage(err)),
  });

  const start = useMutation({
    mutationFn: async () => {
      if (draft) await save.mutateAsync();
      return runExperiment(experimentId);
    },
    onSuccess: () => { setNote('Running…'); refresh(); },
    onError: (err: unknown) => setNote(errorMessage(err)),
  });

  const check = useMutation({
    mutationFn: () => validateAuthored({ tasks: task ? [task] : [] }),
    onSuccess: (d: { tasks?: { ok: boolean; reason?: string; exitCode: number; solutionExitCode?: number }[] }) => {
      const v = d.tasks?.[0];
      setNote(v
        ? `${v.ok ? 'Gate passed' : 'Gate rejected'} — seed-only exit ${v.exitCode}, `
          + `solution exit ${v.solutionExitCode ?? 'not run'}${v.reason ? ` · ${v.reason}` : ''}`
        : 'No verdict.');
    },
    onError: (err: unknown) => setNote(errorMessage(err)),
  });

  const recorded: VariantResult[] = (exp?.results ?? [])
    .filter((r) => r.taskId === task?.id && r.label === variant?.label);

  const generated = (promptId: string) => config?.prompts.find((p) => p.id === promptId)?.text ?? '';

  const field = 'w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2 py-1.5 text-[12px] text-slate-200 font-mono focus:border-[var(--leaf)] focus:outline-none';
  const heading = 'text-[10px] uppercase tracking-widest text-slate-500 mb-1';

  return (
    <EditorSlot.Provider value={slot}>
    <div className="fixed inset-0 z-50 bg-[var(--bark-900)] flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--bark-600)] shrink-0">
        <span className="font-semibold text-slate-200 truncate">{exp?.name ?? 'Loading…'}</span>

        <select
          className={`${field} w-auto`}
          value={task?.id ?? ''}
          onChange={(e) => { setTaskId(e.target.value); setNote(''); slot.close(); }}
        >
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>

        <select
          className={`${field} w-auto`}
          value={variant?.label ?? ''}
          onChange={(e) => { setLabel(e.target.value); setNote(''); slot.close(); }}
        >
          {exp?.variants.map((v) => <option key={v.label} value={v.label}>{v.label}</option>)}
        </select>

        <button
          onClick={() => start.mutate()}
          disabled={running || start.isPending}
          title="Run the whole suite — a real sandbox per task, per variant, per repeat"
          className="flex items-center gap-1.5 text-[12px] px-3 py-1 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-40"
        >
          {running || start.isPending
            ? <Loader2 size={12} className="animate-spin" />
            : <Play size={12} />}
          {running ? 'Running' : dirty ? 'Save & run' : 'Run'}
        </button>

        <button
          onClick={() => setPromoting((p) => !p)}
          disabled={!hasResults}
          title={hasResults
            ? `Adopt ${variant?.label} as the default for experiments and leaf runs`
            : 'This variant has no runs yet — there is nothing to adopt on'}
          className="flex items-center gap-1.5 text-[12px] px-3 py-1 rounded-lg border border-[var(--bark-600)] text-slate-300 hover:bg-[var(--bark-700)] disabled:opacity-40"
        >
          <Award size={12} /> Promote
        </button>

        <button
          onClick={() => { setNote('Checking…'); check.mutate(); }}
          disabled={check.isPending || !task}
          className="flex items-center gap-1.5 text-[12px] px-3 py-1 rounded-lg border border-[var(--bark-600)] text-slate-300 hover:bg-[var(--bark-700)] disabled:opacity-50"
        >
          {check.isPending ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          Check gate
        </button>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !draft}
          className="text-[12px] px-3 py-1 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-40"
        >
          Save experiment
        </button>

        {note && <span className="text-[11px] text-slate-400 truncate max-w-[40%]">{note}</span>}
        <button onClick={onClose} className="ml-auto p-1 text-slate-500 hover:text-slate-200">
          <X size={16} />
        </button>
      </div>

      {promoting && variant && (
        <div className="px-4 shrink-0">
          <PromoteConfirm
            experimentId={experimentId}
            label={variant.label}
            onDone={() => {
              setPromoting(false);
              setNote(`Adopted ${variant.label} as the default.`);
              qc.invalidateQueries({ queryKey: ['harness-profile'] });
              qc.invalidateQueries({ queryKey: ['harness-config'] });
              onSaved();
            }}
            onCancel={() => setPromoting(false)}
          />
        </div>
      )}

      <div className="flex-1 grid grid-cols-2 min-h-0">
        <div className="border-r border-[var(--bark-600)] min-h-0 flex flex-col">
        {request ? (
          <div className="flex-1 min-h-0 p-3">
            <EditorHost request={request} onClose={slot.close} />
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <p className={heading}>Verify command</p>
            <ExpandableText
              label="Verify command"
              value={task?.verifyCommand ?? ''}
              onChange={(v) => patchTask({ verifyCommand: v })}
              rows={3}
              field={field}
            />
            <p className="text-[10px] text-slate-600 mt-1 leading-snug">
              Must FAIL with only the seed present, and PASS with seed + solution. The first proves
              it checks something; the second proves the task can be won.
            </p>
          </div>

          <FileList
            title="Seed — present before the agent starts"
            note="The given state. A prompt that says “read data.txt” needs data.txt here; the agent has nothing else."
            files={task?.seed ?? []}
            field={field}
            heading={heading}
            onChange={(update) => patchFiles('seed', update)}
          />

          <Terminal
            seed={task?.seed ?? []}
            language={task?.language}
            field={field}
            heading={heading}
          />

          <FileList
            title="Solution — reference answer, never given to the agent"
            note="Used only to run the verify command against a known-good result. Without one, achievability is unproven."
            files={task?.solution ?? []}
            field={field}
            heading={heading}
            onChange={(update) => patchFiles('solution', update)}
          />
        </div>
        )}
        </div>

        <div className="grid grid-rows-2 min-h-0">
          <div className="border-b border-[var(--bark-600)] flex flex-col min-h-0">
            <div className="flex items-center gap-1 px-3 pt-2 shrink-0">
              {(['prompt', 'options', 'chat'] as const).map((id) => (
                <button
                  key={id}
                  onClick={() => setPane(id)}
                  className={`text-[11px] px-2.5 py-1 rounded-t border-b-2 capitalize ${
                    pane === id
                      ? 'border-[var(--leaf)] text-slate-200'
                      : 'border-transparent text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {id === 'chat' ? 'Koala' : id}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
            {pane === 'chat' && (
              <TaskChat
                task={task}
                field={field}
                onAccept={(revision) => { patchTask(revision); setPane('prompt'); setNote('Applied — not saved yet.'); }}
              />
            )}
            {pane === 'prompt' && (
            <div>
              <p className={heading}>Prompt</p>
              <ExpandableText
                label={`Prompt — ${task?.name ?? ''}`}
                value={task?.prompt ?? ''}
                onChange={(v) => patchTask({ prompt: v })}
                rows={8}
                field={field}
              />
            </div>
            )}

            {pane === 'options' && (
            <div>
              <p className={heading}>Options — {variant?.label} · pack {armPack?.name ?? '—'} (read-only)</p>
              <table className="w-full text-[11px]">
                <tbody>
                  {(config?.tunables ?? []).map((t) => {
                    const isSet = own[t.key] !== undefined;
                    const live = config?.effective?.find((e) => e.key === t.key);
                    return (
                      <tr key={t.key} title={describeTunable(t, live)}>
                        <td className="py-0.5 pr-2 font-mono text-slate-400 align-middle whitespace-nowrap cursor-help">
                          {t.key}
                        </td>
                        <td className="py-0.5 w-full">
                          {t.choices ? (
                            <select
                              className={`${field} py-0.5`}
                              value={showRaw(own[t.key])}
                              disabled
                            >
                              <option value="">
                                {t.choices.length ? 'unset — first available' : 'no models available'}
                              </option>
                              {t.choices.map((c) => (
                                <option key={c.value} value={c.value}>
                                  {c.note ? `${c.label} — ${c.note}` : c.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                          <ExpandableText
                            label={t.label}
                            value={showRaw(own[t.key])}
                            rows={1}
                            field={`${field} py-0.5`}
                            placeholder={showRaw(live ? live.value : t.default) || 'unset'}
                            expandable={t.type === 'string'}
                            {...(t.type === 'string' ? {
                              fallback: showRaw(live ? live.value : t.default)
                                || (t.promptId ? generated(t.promptId) : ''),
                              fallbackNote: live?.source === 'adopted' ? 'adopted default' : 'harness default',
                            } : {})}
                            onChange={() => undefined}
                          />
                          )}
                        </td>
                        <td className={`py-0.5 pl-2 text-[9px] whitespace-nowrap ${
                          isSet ? 'text-amber-400' : live?.source === 'adopted' ? 'text-amber-400/70' : 'text-slate-700'
                        }`}>
                          {isSet ? 'set' : live?.source === 'adopted' ? 'adopted' : t.engine ?? ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}
            </div>
          </div>

          <OutputPane live={live} results={recorded} heading={heading} />
        </div>
      </div>
    </div>
    </EditorSlot.Provider>
  );
}

function FileList({
  title, note, files, field, heading, onChange,
}: {
  title: string;
  note: string;
  files: TaskFile[];
  field: string;
  heading: string;
  onChange: (update: (files: TaskFile[]) => TaskFile[]) => void;
}) {
  return (
    <div>
      <p className={heading}>{title}</p>
      <p className="text-[10px] text-slate-600 mb-1.5 leading-snug">{note}</p>
      <div className="space-y-2">
        {files.map((f, i) => (
          <div key={i} className="bg-[var(--bark-800)]/60 rounded p-2 space-y-1">
            <div className="flex gap-2">
              <input
                className={`${field} py-0.5`}
                value={f.path}
                placeholder="relative/path.txt"
                onChange={(e) => onChange((cur) => cur.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
              />
              <button
                onClick={() => onChange((cur) => cur.filter((_, j) => j !== i))}
                className="px-2 text-slate-600 hover:text-red-400 text-[11px]"
              >
                remove
              </button>
            </div>
            <ExpandableText
              label={f.path || 'file'}
              value={f.content}
              rows={4}
              field={field}
              onChange={(v) => onChange((cur) => cur.map((x, j) => (j === i ? { ...x, content: v } : x)))}
            />
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange((cur) => [...cur, { path: '', content: '' }])}
        className="mt-1 text-[11px] text-[var(--leaf-light)] hover:text-white"
      >
        + add file
      </button>
    </div>
  );
}
