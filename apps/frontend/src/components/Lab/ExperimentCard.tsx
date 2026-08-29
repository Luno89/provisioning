import { useState } from 'react';
import { Play, Square, Trash2, Copy, Loader2, Maximize2 } from 'lucide-react';
import { card, type Experiment, type HarnessConfig, type HarnessProfile } from './shared';
import { LivePanel, type LiveRun } from './Live';
import { RunHistory } from './History';
import { VariantPanel } from './Variants';
import { TaskPanel } from './Tasks';
import { Results } from './Results';

type Panel = 'results' | 'variants' | 'tasks' | 'history';

export function ExperimentCard({ experiment: e, config, profile, live, openResult, setOpenResult,
  onFocus, onRun, onStop, onDuplicate, onDelete, onChanged, onPromoted,
}: {
  experiment: Experiment;
  config: HarnessConfig | undefined;
  profile: HarnessProfile | null;
  live: LiveRun | undefined;
  openResult: string | null;
  setOpenResult: (v: string | null) => void;
  onFocus: () => void;
  onRun: () => void;
  onStop?: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onChanged: () => void;
  onPromoted: () => void;
}) {
  const [panel, setPanel] = useState<Panel>('results');
  const running = Boolean(e.running || e.status === 'running');
  const hasResults = e.results.length > 0;

  const active: Panel = panel === 'results' && !hasResults ? 'tasks' : panel;

  const tabs: { id: Panel; label: string; badge?: string }[] = [
    { id: 'results', label: 'Results', ...(hasResults ? { badge: String(e.results.length) } : {}) },
    { id: 'variants', label: 'Variants', badge: String(e.variants.length) },
    { id: 'tasks', label: 'Tasks', badge: String(e.tasks.length) },
    ...(e.history?.length > 1 ? [{ id: 'history' as const, label: 'History', badge: String(e.history.length) }] : []),
  ];

  return (
    <div className={card}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-200 truncate">{e.name}</div>
          <div className="text-[11px] text-slate-500">
            {e.tasks.length} task{e.tasks.length > 1 ? 's' : ''} × {e.variants.length} variant
            {e.variants.length > 1 ? 's' : ''} × {e.repeats}
            {e.progress && <span className="text-[var(--leaf-light)]"> · {e.progress}</span>}
          </div>
        </div>
        {running ? (
          <div className="flex items-center gap-1">
            <Loader2 size={16} className="animate-spin text-[var(--leaf-light)] mr-1" />
            <button
              onClick={onStop}
              title="Stop running experiment"
              className="p-1.5 rounded-lg text-red-400 hover:bg-[var(--bark-700)]"
            >
              <Square size={14} fill="currentColor" />
            </button>
          </div>
        ) : (
          <button
            onClick={onRun}
            title="Run — creates a real sandbox per task per variant"
            className="p-1.5 rounded-lg text-[var(--leaf-light)] hover:bg-[var(--bark-700)]"
          >
            <Play size={15} />
          </button>
        )}
        <button
          onClick={onFocus}
          title="Open full screen — verify, prompt and raw output side by side"
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-[var(--bark-700)]"
        >
          <Maximize2 size={15} />
        </button>
        <button
          onClick={onDuplicate}
          title="Duplicate — copies the suite without the results"
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-[var(--bark-700)]"
        >
          <Copy size={15} />
        </button>
        <button
          onClick={onDelete}
          title="Delete"
          className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-[var(--bark-700)]"
        >
          <Trash2 size={15} />
        </button>
      </div>

      {e.error && (
        <div className="mx-4 mb-3 text-[12px] text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
          {e.error}
        </div>
      )}

      {live && <LivePanel run={live} />}

      <div className="border-t border-[var(--bark-600)] flex items-center gap-1 px-3 pt-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setPanel(t.id)}
            className={`text-[12px] px-3 py-1.5 rounded-t-lg border-b-2 ${
              active === t.id
                ? 'border-[var(--leaf)] text-slate-200'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t.label}
            {t.badge && <span className="ml-1.5 text-[10px] text-slate-600">{t.badge}</span>}
          </button>
        ))}
      </div>

      <div className="px-4 py-3 border-t border-[var(--bark-600)]">
        {active === 'results' && (
          hasResults ? (
            <Results
              results={e.results}
              tasks={e.tasks}
              variants={e.variants}
              openResult={openResult}
              setOpenResult={setOpenResult}
              scope={e.id}
              onPromoted={onPromoted}
            />
          ) : (
            <p className="text-[12px] text-slate-500">Not run yet.</p>
          )
        )}
        {active === 'variants' && (
          <VariantPanel
            experiment={e}
            tunables={config?.tunables ?? []}
            effective={config?.effective ?? []}
            prompts={Object.fromEntries((config?.prompts ?? []).map((p) => [p.id, p.text]))}
            profile={profile}
            disabled={running}
            onSaved={onChanged}
          />
        )}
        {active === 'tasks' && (
          <TaskPanel experiment={e} disabled={running} onSaved={onChanged} />
        )}
        {active === 'history' && <RunHistory history={e.history} />}
      </div>
    </div>
  );
}
