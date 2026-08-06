import { useState } from 'react';
import { ExpandableText } from './ExpandableText';
import { useMutation } from '@tanstack/react-query';
import axios from 'axios';
import { useExperimentDetail, tasksOf, type Experiment, type ExperimentTask, errorMessage } from './shared';

export function TaskPanel({
  apiBase, experiment, disabled, onSaved,
}: {
  apiBase: string;
  experiment: Experiment;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ExperimentTask[]>([]);
  const [error, setError] = useState('');

  // Prompts are the largest field in a record and the list deliberately omits them, so selecting
  // this tab is what pays for them — nothing fetches until you ask.
  const { data: detail, isPending } = useExperimentDetail(apiBase, experiment.id, true);
  const tasks = detail ? tasksOf(detail) : [];

  const save = useMutation({
    mutationFn: () =>
      axios.put(`${apiBase}/harness/experiments/${experiment.id}`, { tasks: draft }, { withCredentials: true }),
    onSuccess: () => { setEditing(false); setError(''); onSaved(); },
    onError: (err: unknown) => setError(errorMessage(err)),
  });

  const beginEdit = () => { setDraft(tasks.map((t) => ({ ...t }))); setEditing(true); setError(''); };
  const patch = (i: number, p: Partial<ExperimentTask>) =>
    setDraft((ts) => ts.map((t, j) => (j === i ? { ...t, ...p } : t)));

  // Counted per task, since only the ones actually reworded lose their history. Uses the summary's
  // results, which carry taskId — the field this needs and the only one it needs.
  const atRisk = editing
    ? experiment.results.filter((r) => {
        const i = tasks.findIndex((t) => t.id === r.taskId);
        const edited = draft[i];
        return edited && (edited.prompt !== tasks[i]!.prompt
          || edited.verifyCommand !== tasks[i]!.verifyCommand);
      }).length
    : 0;

  const field = 'w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2 py-1.5 text-[12px] text-slate-200 focus:border-[var(--leaf)] focus:outline-none';

  return (
    <div className="space-y-2">
          {isPending && <p className="text-[11px] text-slate-500">Loading the prompts…</p>}
          {(editing ? draft : tasks).map((t, i) => (
            <div key={t.id} className="bg-[var(--bark-900)]/50 rounded-lg p-2.5">
              {editing ? (
                <div className="space-y-1.5">
                  <input className={field} value={t.name} onChange={(ev) => patch(i, { name: ev.target.value })} />
                  <ExpandableText
                    label={`Prompt — ${t.name}`}
                    value={t.prompt}
                    rows={6}
                    field={`${field} font-mono`}
                    onChange={(v) => patch(i, { prompt: v })}
                  />
                  <input
                    className={`${field} font-mono`}
                    value={t.verifyCommand}
                    onChange={(ev) => patch(i, { verifyCommand: ev.target.value })}
                  />
                </div>
              ) : (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12px] font-semibold text-slate-300">{t.name}</span>
                    {t.language && <span className="text-[10px] text-slate-600 font-mono">{t.language}</span>}
                  </div>
                  <pre className="text-[11px] text-slate-400 whitespace-pre-wrap mt-1 leading-relaxed">{t.prompt}</pre>
                  <p className="text-[10px] text-[var(--leaf-light)] font-mono mt-1.5">$ {t.verifyCommand}</p>
                </>
              )}
            </div>
          ))}

          {error && <p className="text-[11px] text-red-400">{error}</p>}

          {editing ? (
            <div className="flex items-center gap-3">
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-50"
              >
                Save
              </button>
              <button onClick={() => setEditing(false)} className="text-[12px] text-slate-500 hover:text-slate-300">
                Cancel
              </button>
              {atRisk > 0 && (
                <span className="text-[11px] text-slate-500">
                  {`${atRisk} past result${atRisk > 1 ? 's' : ''} measured the old wording — kept in history, which records the prompt each run was actually sent.`}
                </span>
              )}
            </div>
          ) : (
            <button
              onClick={beginEdit}
              // Also blocked until the prompts have arrived: editing a draft built from an
              // unloaded suite would open empty fields and save them over the real ones.
              disabled={disabled || !tasks.length}
              title={disabled ? 'Wait for the run to finish' : 'Edit the prompts'}
              className="text-[12px] text-[var(--leaf-light)] hover:text-white disabled:opacity-40"
            >
              Edit prompts
            </button>
          )}
    </div>
  );
}
