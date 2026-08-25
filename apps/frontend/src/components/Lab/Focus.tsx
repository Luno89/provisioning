/**
 * One experiment, full screen, with the three things you actually iterate on side by side.
 *
 * ── WHY A DEDICATED MODE ──
 * Authoring a task means moving between the verify command, the prompt and what the model actually
 * did — repeatedly, in that order. In the card layout those live in three different tabs, so every
 * loop costs two clicks and you can never see the output that motivated the edit while making it.
 *
 *   ┌───────────────────────┬───────────────────────┐
 *   │                       │ prompt + raw options  │
 *   │  verify definition    ├───────────────────────┤
 *   │  seed / solution      │ raw model output      │
 *   └───────────────────────┴───────────────────────┘
 *
 * Verify gets the left half because it is the part with the most moving pieces — command, seed,
 * solution, and both sides of the gate. The right column is the loop's feedback: what was asked,
 * and what came back, one above the other.
 *
 * Expanding any field takes over that left half rather than opening over the page, so a long prompt
 * is edited beside the output that prompted the edit instead of on top of it.
 *
 * ── RAW VALUES, DELIBERATELY ──
 * Every knob here is editable as its literal value rather than through a widget. This is the view
 * for someone who knows what `dry_allowed_length` does and wants to type 3, not pick from a slider
 * whose range someone guessed. The registry still supplies the list and the types, so nothing can
 * be set that the request will not carry.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Play, Award, Loader2 } from 'lucide-react';
import { Terminal } from './Terminal';
import { ExpandableText, EditorHost } from './ExpandableText';
import { TaskChat } from './TaskChat';
import { PromoteConfirm } from './Promote';
import { OutputPane } from './Output';
import type { LiveRun } from './Live';
import {
  useExperimentDetail, errorMessage, describeTunable, useEditorSlot, EditorSlot,
  type ExperimentTask, type HarnessConfig, type TaskFile, type VariantResult,
} from './shared';
import { updateExperiment, runExperiment, validateAuthored } from '../../api/harness';

/** A knob's value as typed. The registry decides how to read it back. */
const parseRaw = (raw: string, type: string): unknown => {
  const text = raw.trim();
  if (text === '') return undefined;
  if (type === 'number') {
    const n = Number(text);
    return Number.isNaN(n) ? text : n;
  }
  if (type === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    return text;
  }
  return raw;
};

const showRaw = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export function Focus({ experimentId, config, live, onClose, onSaved,
}: {
  experimentId: string;
  config: HarnessConfig | undefined;
  /** A run of this experiment in flight, streamed over sockets by the page. */
  live: LiveRun | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: exp } = useExperimentDetail(experimentId, true);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExperimentTask[] | null>(null);
  const [overrides, setOverrides] = useState<Record<string, unknown> | null>(null);
  const [note, setNote] = useState('');
  // The upper-right quadrant holds three things that are alternatives, not additions:
  // what is asked, how it is called, and a conversation about both.
  const [pane, setPane] = useState<'prompt' | 'options' | 'chat'>('prompt');
  const [promoting, setPromoting] = useState(false);
  const { slot, request } = useEditorSlot();
  const qc = useQueryClient();

  /**
   * Refetches THIS experiment.
   *
   * The page's `onSaved` invalidates the experiment LIST, which is a different query from the one
   * this view reads. Without this, saving cleared the local draft and then re-rendered from the
   * stale cached detail — so a successful save looked exactly like a discarded edit — and starting
   * a run never turned the poll on, because the interval is evaluated against data still saying
   * nothing was running.
   */
  const refresh = () => qc.invalidateQueries({ queryKey: ['experiment', experimentId] });

  // Escape closes. A full-screen overlay with no keyboard exit is a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tasks = draft ?? exp?.tasks ?? [];
  const task = tasks.find((t) => t.id === taskId) ?? tasks[0];
  const variant = exp?.variants.find((v) => v.label === label) ?? exp?.variants[0];
  const own = overrides ?? variant?.overrides ?? {};
  const dirty = draft !== null || overrides !== null;
  const running = Boolean(exp?.running) || exp?.status === 'running';
  // Promotion is measured against evidence, so a variant nothing has run cannot be adopted.
  const hasResults = (exp?.results ?? []).some((r) => r.label === variant?.label);

  // Functional, because the editor holds one of these long after the field that made it is gone —
  // and Koala can revise the same task from the other pane while it is open. Built on `tasks` read
  // during render, a late commit would restore the suite as it was when the editor opened.
  const patchTask = (patch: Partial<ExperimentTask>) =>
    setDraft((prev) => (prev ?? exp?.tasks ?? []).map((t) => (t.id === task?.id ? { ...t, ...patch } : t)));

  /** The same, for the file lists — whose edits are relative to what is there rather than absolute. */
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
    onSuccess: () => { setNote('Saved.'); setDraft(null); setOverrides(null); refresh(); onSaved(); },
    onError: (err: unknown) => setNote(errorMessage(err)),
  });

  /**
   * Starts the suite.
   *
   * Saves first when there is anything unsaved, and says so on the button. A run measures what the
   * server holds, so running with edits on screen would have produced a record of the previous
   * wording under the new one's name — the exact confusion the whole surface exists to prevent.
   */
  const start = useMutation({
    mutationFn: async () => {
      if (draft || overrides) await save.mutateAsync();
      return runExperiment(experimentId);
    },
    // `isRunning` flips before the route answers, so the refetch this triggers already sees it.
    onSuccess: () => { setNote('Running…'); refresh(); },
    onError: (err: unknown) => setNote(errorMessage(err)),
  });

  /** Runs both halves of the gate against this task, without starting the experiment. */
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

  // Every recorded run of this task by this variant, oldest first. Not just the last: repeats
  // exist to show variance, and collapsing them to one silently defeats the point of asking for
  // three. The pane picks which to show and says which it is showing.
  const recorded: VariantResult[] = (exp?.results ?? [])
    .filter((r) => r.taskId === task?.id && r.label === variant?.label);

  /** The generated prompt a knob replaces, for knobs whose default is built rather than stored. */
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
          // The editor closes on a switch: it is editing one field of one task, and there is no
          // answer to what Save should mean once that is no longer the task on screen.
          onChange={(e) => { setTaskId(e.target.value); setNote(''); slot.close(); }}
        >
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>

        <select
          className={`${field} w-auto`}
          value={variant?.label ?? ''}
          onChange={(e) => { setLabel(e.target.value); setOverrides(null); setNote(''); slot.close(); }}
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
          {/* The save is named rather than silent: an implicit write is a surprise, and the whole
              point of naming it is that you know which version is about to be measured. */}
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
          disabled={save.isPending || (!draft && !overrides)}
          className="text-[12px] px-3 py-1 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-40"
        >
          {/* Named for what it writes, because the field editor also has a Save and that one only
              reaches this page's draft. Two buttons reading "Save" is a question, not a label. */}
          Save experiment
        </button>

        {note && <span className="text-[11px] text-slate-400 truncate max-w-[40%]">{note}</span>}
        <button onClick={onClose} className="ml-auto p-1 text-slate-500 hover:text-slate-200">
          <X size={16} />
        </button>
      </div>

      {/* Under the header rather than in it: a promotion shows a standing and a diff, and those
          are the whole reason it is a confirm instead of a button. */}
      {promoting && variant && (
        <div className="px-4 shrink-0">
          <PromoteConfirm
            experimentId={experimentId}
            label={variant.label}
            onDone={() => {
              setPromoting(false);
              setNote(`Adopted ${variant.label} as the default.`);
              // The adopted profile decides what every unset knob resolves to, so the config the
              // options table reads is now wrong too.
              qc.invalidateQueries({ queryKey: ['harness-profile'] });
              qc.invalidateQueries({ queryKey: ['harness-config'] });
              onSaved();
            }}
            onCancel={() => setPromoting(false)}
          />
        </div>
      )}

      <div className="flex-1 grid grid-cols-2 min-h-0">
        {/* ── left half: the verify definition, or the editor that has claimed its space ── */}
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
              {/* Both halves stated, because the gate checks both and a command can fail either. */}
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
          {/* ── upper right: what is asked, and every knob as a raw value ── */}
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
                // Applied to the editors, not saved: the accept is where you read it, and Save is
                // still a separate deliberate act.
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
              <p className={heading}>Options — {variant?.label} (raw values)</p>
              <table className="w-full text-[11px]">
                <tbody>
                  {(config?.tunables ?? []).map((t) => {
                    const isSet = own[t.key] !== undefined;
                    // The value the run WOULD use if this variant left the knob alone — adopted
                    // defaults folded in. Showing the built-in constant here would offer a
                    // baseline nobody is running, which is the opposite of tuning the harness.
                    const live = config?.effective?.find((e) => e.key === t.key);
                    return (
                      <tr key={t.key} title={describeTunable(t, live)}>
                        <td className="py-0.5 pr-2 font-mono text-slate-400 align-middle whitespace-nowrap cursor-help">
                          {t.key}
                        </td>
                        <td className="py-0.5 w-full">
                          {/* Discovered values — the model APIs you can actually reach — are a
                              picker, because the id is opaque and typing one only ever produced
                              "not found". Driven by the registry declaring where they come from,
                              so this stays true of any future knob. */}
                          {t.choices ? (
                            <select
                              className={`${field} py-0.5`}
                              value={showRaw(own[t.key])}
                              onChange={(e) => setOverrides((prev) => {
                                const next = { ...(prev ?? variant?.overrides ?? {}) };
                                if (e.target.value === '') delete next[t.key];
                                else next[t.key] = e.target.value;
                                return next;
                              })}
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
                          /* A system prompt is 1,600 characters and this is a table row, so the
                             field stays one line and grows on demand. */
                          <ExpandableText
                            label={t.label}
                            value={showRaw(own[t.key])}
                            rows={1}
                            field={`${field} py-0.5`}
                            // The registry's default shown as the placeholder, so an empty field
                            // reads as "whatever the harness does" rather than as zero.
                            placeholder={showRaw(live ? live.value : t.default) || 'unset'}
                            // Text only, both of them. A prompt has to be read before it can be
                            // tuned, so the editor opens on the one in force; a number is one
                            // value, with nothing to expand into and nothing to prepopulate that
                            // the placeholder does not already say.
                            expandable={t.type === 'string'}
                            {...(t.type === 'string' ? {
                              fallback: showRaw(live ? live.value : t.default)
                                || (t.promptId ? generated(t.promptId) : ''),
                              fallbackNote: live?.source === 'adopted' ? 'adopted default' : 'harness default',
                            } : {})}
                            // Functional for the same reason as patchTask: this knob's editor can
                            // still be open while another knob is set behind it.
                            onChange={(raw) => setOverrides((prev) => {
                              const next = { ...(prev ?? variant?.overrides ?? {}) };
                              const parsed = parseRaw(raw, t.type);
                              if (parsed === undefined) delete next[t.key];
                              else next[t.key] = parsed;
                              return next;
                            })}
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

          {/* ── lower right: what came back, live while it happens ── */}
          <OutputPane live={live} results={recorded} heading={heading} />
        </div>
      </div>
    </div>
    </EditorSlot.Provider>
  );
}

/** Seed and solution share a shape, so they share an editor. */
function FileList({
  title, note, files, field, heading, onChange,
}: {
  title: string;
  note: string;
  files: TaskFile[];
  field: string;
  heading: string;
  /** An updater, not an array: a content edit can land after this list has stopped existing. */
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
