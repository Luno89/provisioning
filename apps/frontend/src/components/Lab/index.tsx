/**
 * The Lab — what the harness is set to, and what happens when you change it.
 *
 * ── TWO TABS, BECAUSE THEY ARE TWO QUESTIONS ──
 * These were one column: settings, then prompts, then experiments, all scrolling past each other.
 * But "what is this thing configured to do" and "what happens when I change it" get asked at
 * different moments, and stacking them meant the configuration sat above every experiment forever
 * while the work you came for started below the fold.
 *
 * The column that matters in every results table is still `verified`, not `succeeded` — the
 * agent's own report is the least trustworthy number in a run.
 */
import { useSocketEvent } from '../../stores/socket';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Plus } from 'lucide-react';
import { KoalaSpot } from '../Koala';
import { card, type Experiment, type HarnessConfig, type HarnessProfile } from './shared';
import { Harness } from './Harness';
import { ExperimentCard } from './ExperimentCard';
import { NewExperiment } from './NewExperiment';
import { Focus } from './Focus';
import { ToolRepoPanel } from './ToolRepoPanel';
import { MemoryBankPanel } from './MemoryBankPanel';
import type { LiveRun } from './Live';
import type {
  ExperimentRunFinished, ExperimentRunStarted, ExperimentStepEvent,
} from '@koala/harness-types';
import {
  getConfig, getProfile, listExperiments, runExperiment, stopExperiment,
  duplicateExperiment, deleteExperiment,
} from '../../api/harness';

/** Steps kept for a run in flight. A window onto work happening, not a record — the trace is that. */
const MAX_LIVE_STEPS = 12;

type Tab = 'experiments' | 'tool-repo' | 'memories' | 'harness';

export default function Lab() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('experiments');
  const [live, setLive] = useState<Record<string, LiveRun>>({});
  const [openResult, setOpenResult] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);

  const { data: config } = useQuery<HarnessConfig>({
    queryKey: ['harness-config'],
    queryFn: getConfig,
  });

  const { data: profile } = useQuery<HarnessProfile | null>({
    queryKey: ['harness-profile'],
    queryFn: getProfile,
  });

  const { data: experiments } = useQuery<Experiment[]>({
    queryKey: ['experiments'],
    queryFn: listExperiments,
    /**
     * Polled only while something is actually running.
     *
     * Against a growing archive of finished experiments a fixed interval re-fetches the whole list
     * forever to learn nothing, and the live panel already carries progress over sockets.
     */
    refetchInterval: (query) =>
      (query.state.data ?? []).some((e) => e.running || e.status === 'running') ? 5000 : false,
  });

  /**
   * Live experiment frames, over the SHARED connection.
   *
   * This opened its own `io()` — one of three in the app, so having the Lab and a project on screen
   * meant three handshakes and three server-side sessions for one user. These three events are
   * broadcast rather than room-routed, so they are safe to share; see `stores/socket.ts` for why
   * log streaming still is not.
   */

  // A new variant replaces the buffer rather than appending: the steps of the run that just ended
  // belong to its result, and mixing two runs' steps would read plausibly and mean nothing.
  useSocketEvent<ExperimentRunStarted>('experiment-run-started', (d) => setLive((prev) => ({
    ...prev,
    [d.experimentId]: {
      taskId: d.taskId, taskName: d.taskName, label: d.label,
      done: d.done, total: d.total, steps: [],
    },
  })));

  useSocketEvent<ExperimentStepEvent>('experiment-step', (d) => setLive((prev) => {
    const current = prev[d.experimentId];
    // Frames can arrive out of order around a handover, and one late step must not relabel it.
    if (!current || current.label !== d.label || current.taskId !== d.taskId) return prev;
    return {
      ...prev,
      [d.experimentId]: { ...current, steps: [...current.steps, d.step].slice(-MAX_LIVE_STEPS) },
    };
  }));

  /**
   * Declared BEFORE the socket handlers that call it.
   *
   * It sat below them, which worked only because a socket event cannot fire until after the
   * component body has run — the handler closed over a `const` still in its temporal dead zone at
   * the moment it was registered. True today, and silently untrue the first time anything calls it
   * synchronously during render.
   */
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['experiments'] });
    qc.invalidateQueries({ queryKey: ['experiment'] });
  };

  // Cleared on landing: from that moment the authoritative record is the trace on the result.
  useSocketEvent<ExperimentRunFinished>('experiment-run-finished', (d) => {
    setLive((prev) => {
      if (!prev[d.experimentId]) return prev;
      const rest = { ...prev };
      delete rest[d.experimentId];
      return rest;
    });
    invalidate();
  });

  const run = useMutation({
    mutationFn: (id: string) => runExperiment(id),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteExperiment(id),
    onSuccess: invalidate,
  });
  const duplicate = useMutation({
    mutationFn: (id: string) =>
      duplicateExperiment(id),
    onSuccess: invalidate,
  });
  const stop = useMutation({
    mutationFn: (id: string) => stopExperiment(id),
    onSuccess: invalidate,
  });

  const anyRunning = (experiments ?? []).some((e) => e.running || e.status === 'running');
  const tabClass = (id: Tab) => `px-4 py-2 text-[13px] rounded-lg ${
    tab === id ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-500 hover:text-slate-300'
  }`;

  // Rendered outside the page's max-width so it genuinely fills the viewport.
  if (focused) {
    return (
      <Focus
        experimentId={focused}
        config={config}
        live={live[focused]}
        onClose={() => setFocused(null)}
        onSaved={invalidate}
      />
    );
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-1">
        <FlaskConical className="text-[var(--leaf-light)]" size={26} />
        <h2 className="text-3xl font-bold">Lab</h2>
        <KoalaSpot size={34} mood={anyRunning ? 'thinking' : 'idle'} className="ml-auto sway" />
      </div>
      <p className="text-slate-500 text-sm mb-5">
        What the agent is configured to do, and what happens when you change it.
      </p>

      <div className="flex items-center gap-1 mb-6 border-b border-[var(--bark-600)] pb-2">
        <button onClick={() => setTab('experiments')} className={tabClass('experiments')}>
          Experiments
          {experiments?.length ? <span className="ml-1.5 text-[11px] text-slate-600">{experiments.length}</span> : null}
        </button>
        <button onClick={() => setTab('tool-repo')} className={tabClass('tool-repo')}>Tool Repo</button>
        <button onClick={() => setTab('memories')} className={tabClass('memories')}>Memories</button>
        <button onClick={() => setTab('harness')} className={tabClass('harness')}>Harness</button>
      </div>

      {tab === 'tool-repo' && <ToolRepoPanel />}
      {tab === 'memories' && <MemoryBankPanel />}

      {tab === 'harness' && (
        <Harness
          config={config}
          profile={profile ?? null}
          onProfileChanged={() => qc.invalidateQueries({ queryKey: ['harness-profile'] })}
          onImported={invalidate}
        />
      )}

      {tab === 'experiments' && (
        <>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={() => setCreating((c) => !c)}
              className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white"
            >
              <Plus size={13} /> New experiment
            </button>
          </div>

          {creating && config && (
            <NewExperiment
              languages={config.languages}
              limits={config.limits}
              tunables={config.tunables ?? []}
              onDone={() => { setCreating(false); invalidate(); }}
            />
          )}

          {experiments?.length === 0 && !creating && (
            <div className={`${card} p-8 text-center`}>
              <KoalaSpot size={56} mood="idle" className="mx-auto opacity-60 mb-3" />
              <p className="text-slate-500 text-sm">No experiments yet. Change one thing, measure it.</p>
            </div>
          )}

          <div className="space-y-3">
            {experiments?.map((e) => (
              <ExperimentCard
                key={e.id}
                experiment={e}
                config={config}
                profile={profile ?? null}
                live={live[e.id]}
                openResult={openResult}
                setOpenResult={setOpenResult}
                onFocus={() => setFocused(e.id)}
                onRun={() => run.mutate(e.id)}
                onStop={() => stop.mutate(e.id)}
                onDuplicate={() => duplicate.mutate(e.id)}
                onDelete={() => remove.mutate(e.id)}
                onChanged={invalidate}
                onPromoted={() => qc.invalidateQueries({ queryKey: ['harness-profile'] })}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
