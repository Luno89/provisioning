import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import axios from 'axios';
import { Plus, Trash2 } from 'lucide-react';
import { card, GROUP_LABEL, describeValue, describeTunable, type Tunable, errorMessage } from './shared';
import { ExpandableText } from './ExpandableText';

interface DraftTask { name: string; prompt: string; verifyCommand: string; language: string }

const blankTask = (): DraftTask => ({ name: '', prompt: '', verifyCommand: '', language: 'node' });

export function NewExperiment({
  apiBase, languages, limits, tunables, onDone,
}: {
  apiBase: string;
  languages: { id: string; summary: string }[];
  limits: { maxVariants: number; maxRepeats: number; maxTasks: number; maxTotalRuns: number };
  tunables: Tunable[];
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [tasks, setTasks] = useState<DraftTask[]>([blankTask()]);
  const [repeats, setRepeats] = useState(1);
  const [axes, setAxes] = useState<Record<string, unknown[]>>({ think: [false, true] });
  const [error, setError] = useState('');

  const create = useMutation({
    mutationFn: () =>
      axios.post(`${apiBase}/harness/experiments`,
        // The suite's first language doubles as the experiment default, so a record always has one
        // even though every task carries its own.
        { name, tasks, language: tasks[0]?.language ?? 'node', axes, repeats },
        { withCredentials: true }),
    onSuccess: onDone,
    onError: (err: unknown) => setError(errorMessage(err)),
  });

  const toggleAxis = (key: string, values: unknown[]) =>
    setAxes((a) => (a[key] ? Object.fromEntries(Object.entries(a).filter(([k]) => k !== key)) : { ...a, [key]: values }));

  const patchTask = (index: number, patch: Partial<DraftTask>) =>
    setTasks((ts) => ts.map((t, i) => (i === index ? { ...t, ...patch } : t)));

  // The cross product, which is what the server will build. Selecting a third axis multiplies
  // past the ceiling quickly, and the server rejects rather than quietly dropping combinations —
  // so the form has to say so here, before the Create button is worth pressing.
  // A knob is a one-click axis only when the registry names two ends worth comparing.
  const offerable = tunables.filter((t) => t.suggested?.length);

  const variantCount = Object.values(axes).reduce((n, vs) => n * (vs.length || 1), 1);
  const totalRuns = tasks.length * variantCount * repeats;
  const overCap = variantCount > limits.maxVariants
    ? `${variantCount} variants is over the limit of ${limits.maxVariants}. `
      + 'Drop an axis — otherwise some combinations would go unmeasured.'
    // Three individually reasonable choices multiply into this, so it is stated as the product.
    : totalRuns > limits.maxTotalRuns
      ? `${tasks.length} × ${variantCount} × ${repeats} is ${totalRuns} sandboxes, over the limit `
        + `of ${limits.maxTotalRuns}. Cut tasks, variants or repeats.`
      : '';
  const field = 'w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-[var(--leaf)] focus:outline-none';

  return (
    <div className={`${card} p-4 mb-4 space-y-3`}>
      <input className={field} placeholder="Name — e.g. reasoning on dispatch turns" value={name} onChange={(e) => setName(e.target.value)} />

      <div>
        <div className="flex items-baseline gap-2 mb-2">
          <p className="text-[10px] uppercase tracking-widest text-slate-500">Tasks</p>
          <p className="text-[11px] text-slate-600">
            {/* The reason the suite editor exists at all, said once where it is acted on. */}
            One task measures whether a setting suits one prompt. Several measure whether it is better.
          </p>
        </div>

        <div className="space-y-2">
          {tasks.map((t, i) => (
            <div key={i} className="bg-[var(--bark-900)]/60 border border-[var(--bark-600)] rounded-lg p-3 space-y-2">
              <div className="flex gap-2">
                <input
                  className={`${field} py-1.5 text-[12px]`}
                  placeholder={`Task ${i + 1} name — e.g. fib`}
                  value={t.name}
                  onChange={(e) => patchTask(i, { name: e.target.value })}
                />
                <select
                  className={`${field} py-1.5 text-[12px] w-32`}
                  value={t.language}
                  onChange={(e) => patchTask(i, { language: e.target.value })}
                >
                  {languages.map((l) => <option key={l.id} value={l.id}>{l.id}</option>)}
                </select>
                {tasks.length > 1 && (
                  <button
                    onClick={() => setTasks((ts) => ts.filter((_, j) => j !== i))}
                    title="Remove task"
                    className="px-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-[var(--bark-700)]"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              <ExpandableText
                label={`Task ${i + 1} prompt`}
                value={t.prompt}
                rows={5}
                field={`${field} font-mono text-[12px]`}
                placeholder={'Given to the agent verbatim.\ne.g. Create /work/fib.js exporting fib(n), and /work/test.js that checks fib(10) === 55 and prints PASS.'}
                onChange={(v) => patchTask(i, { prompt: v })}
              />
              <input
                className={`${field} py-1.5 font-mono text-[12px]`}
                placeholder="Verify command — e.g. cd /work && node test.js"
                value={t.verifyCommand}
                onChange={(e) => patchTask(i, { verifyCommand: e.target.value })}
              />
            </div>
          ))}
        </div>

        <button
          onClick={() => setTasks((ts) => [...ts, blankTask()])}
          disabled={tasks.length >= limits.maxTasks}
          className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--leaf-light)] hover:text-white disabled:opacity-40 disabled:hover:text-[var(--leaf-light)]"
        >
          <Plus size={13} /> Add task
        </button>
        <p className="text-[11px] text-slate-500 mt-2">
          Each task's verify command runs in its sandbox after the agent stops. Its exit code decides
          whether the variant worked — not the agent's own report, which is the least reliable number
          in the run.
        </p>
      </div>

      <div className="flex gap-3">
        <select className={field} value={repeats} onChange={(e) => setRepeats(Number(e.target.value))}>
          {[1, 2, 3, 5].filter((n) => n <= limits.maxRepeats)
            .map((n) => <option key={n} value={n}>{n} run{n > 1 ? 's' : ''} per task</option>)}
        </select>
      </div>

      <div>
        <div className="flex items-baseline gap-2 mb-2">
          <p className="text-[10px] uppercase tracking-widest text-slate-500">Vary</p>
          <p className="text-[11px] text-slate-600">
            Everything the harness can change about the call. Unpicked knobs run at their default,
            which is what the harness does today.
          </p>
        </div>

        {['sampling', 'loop', 'prompt'].map((group) => {
          // Only knobs with two ends worth comparing become one-click axes. The rest are real and
          // sendable, but picking values for them is a judgement the form cannot make.
          const inGroup = offerable.filter((t) => t.group === group);
          if (!inGroup.length) return null;
          return (
            <div key={group} className="mb-2">
              <p className="text-[10px] text-slate-600 mb-1">{GROUP_LABEL[group] ?? group}</p>
              <div className="flex flex-wrap gap-2">
                {inGroup.map((t) => {
                  const values = t.suggested!;
                  const on = Boolean(axes[t.key]);
                  return (
                    <button
                      key={t.key}
                      onClick={() => toggleAxis(t.key, values)}
                      title={describeTunable(t)}
                      className={`text-[12px] px-3 py-1.5 rounded-lg border ${
                        on
                          ? 'border-[var(--leaf-stem)] bg-[var(--leaf-stem)]/20 text-[var(--leaf-light)]'
                          : 'border-[var(--bark-600)] text-slate-400 hover:bg-[var(--bark-700)]'
                      }`}
                    >
                      {t.label}
                      {on && <span className="ml-1.5 font-mono">{values.map(describeValue).join(' vs ')}</span>}
                      {/* Engine-gated knobs are dropped on a different engine rather than failing
                          the run, so the picker says which before you spend sandboxes on it. */}
                      {t.engine && <span className="ml-1.5 text-[10px] text-slate-600">{t.engine}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className="text-[12px] text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={() => { setError(''); create.mutate(); }}
          disabled={create.isPending || Boolean(overCap)}
          className="text-[13px] px-4 py-2 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-50"
        >
          Create
        </button>
        <span className={`text-[11px] ${overCap ? 'text-amber-400' : 'text-slate-500'}`}>
          {/* Stated before it runs, because each one is a real pod and real tokens. */}
          {overCap || `${totalRuns} sandbox${totalRuns > 1 ? 'es' : ''} will be created when you run it.`}
        </span>
      </div>
    </div>
  );
}
