import { useState } from 'react'
import ModelSelector from '../ModelSelector/ModelSelector'
import ScenarioEditor from './ScenarioEditor'
import CheckResult from './CheckResult'
import type { Scenario } from '../../api/evals'
import { useChecksStore } from '../../stores/checks'
import { LEVEL_LABELS, MODEL_LABELS, checkKind, matchesFilter, type CheckLevel, type CheckModel } from '../../lib/check-kind'
import { scenarioSubjects, scopeLabel, within, type Scope } from '../../lib/check-subjects'
import { historyOf } from '../../lib/check-history'
import { scopedDraft } from '../../lib/scenario-draft'
import {
  fieldClass,
  panelClass,
  primaryButton,
  quietButton,
  useCancelLevel2Run,
  useDeleteScenario,
  useLevel2Runs,
  useModels,
  useScenarios,
  useSelection,
  useStartLevel2Run,
} from './shared'

const tone = (passed: boolean) => (passed ? 'text-emerald-400' : 'text-rose-400')

const when = (at: string) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export interface CheckListProps {
  scope: Scope
  agents: string[]
  procedures: string[]
}

export default function CheckList({ scope, agents, procedures }: CheckListProps) {
  const scenarios = useScenarios()
  const runs = useLevel2Runs()
  const models = useModels()
  const start = useStartLevel2Run(() => undefined)
  const cancel = useCancelLevel2Run()
  const remove = useDeleteScenario()

  const proposed = useChecksStore((s) => s.proposed)
  const clearProposed = useChecksStore((s) => s.clearProposed)
  const proposedHere = proposed && within(scenarioSubjects(proposed), scope) ? proposed : undefined
  const [editing, setEditing] = useState<{ id: string | null; seed?: Scenario | undefined } | undefined>(() => (proposedHere ? { id: null, seed: proposedHere } : undefined))
  const [opened, setOpened] = useState<{ scenarioId: string; runId: string }>()
  const [level, setLevel] = useState<CheckLevel>()
  const [player, setPlayer] = useState<CheckModel>()
  const [modelId, setModelId] = useState('')
  const [temperature, setTemperature] = useState('')

  const inScope = (scenarios.data ?? []).filter((scenario) => within(scenarioSubjects(scenario), scope))
  const shown = inScope.filter((scenario) => matchesFilter(checkKind(scenario), { level, model: player }))
  const selection = useSelection(shown.map((scenario) => scenario.id))
  const allRuns = runs.data ?? []
  const running = allRuns.find((run) => run.state === 'running' && run.scenarios.some((id) => inScope.some((scenario) => scenario.id === id)))
  const editingScenario = editing?.seed ?? (editing?.id ? inScope.find((scenario) => scenario.id === editing.id) : undefined)

  const closeEditor = () => {
    setEditing(undefined)
    if (proposedHere) clearProposed()
  }

  const launch = (only: string[]) => start.mutate({
    only,
    ...(temperature.trim() ? { temperature: Number(temperature) } : {}),
    ...(modelId ? { modelId, modelLabel: models.data?.find((entry) => entry.id === modelId)?.name ?? modelId } : {}),
  })

  return (
    <div className="flex flex-col gap-3">
      <section className={`flex flex-wrap items-center gap-3 ${panelClass}`}>
        <button
          type="button"
          disabled={Boolean(running) || start.isPending || selection.chosen.length === 0}
          onClick={() => launch(selection.chosen)}
          className={primaryButton}
        >
          {running ? 'Running…' : `Run ${selection.chosen.length} check${selection.chosen.length === 1 ? '' : 's'}`}
        </button>
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <span>Model</span>
          <ModelSelector value={modelId} onChange={setModelId} className="w-56" placeholder="Account default" />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-400" title="Blank uses whatever sampling the agent declares">
          Temp
          <input type="number" step={0.1} min={0} max={2} placeholder="auto" value={temperature} onChange={(event) => setTemperature(event.target.value)} className={`w-20 ${fieldClass}`} />
        </label>
        <div className="flex gap-2 text-sm">
          <button type="button" onClick={selection.all} className="text-sky-400 hover:underline">All</button>
          <button type="button" onClick={selection.none} className="text-slate-500 hover:underline">None</button>
        </div>
        <button type="button" onClick={() => setEditing({ id: null })} className={`ml-auto ${quietButton}`}>New check</button>
        {running && <button type="button" onClick={() => cancel.mutate(running.id)} className={quietButton}>Stop</button>}
      </section>

      {start.isError && <p className="text-sm text-rose-400">Could not start: {String((start.error as Error).message)}</p>}

      {editing && (
        <ScenarioEditor
          scenario={editingScenario}
          agents={agents}
          procedures={procedures}
          blank={scopedDraft(scope, agents[0] ?? '')}
          onClose={closeEditor}
          onSaved={closeEditor}
          {...(editing.seed ? { heading: `A new check from a run: ${editing.seed.name}` } : {})}
        />
      )}

      <section className="flex flex-wrap items-center gap-2 text-xs" aria-label="Filter checks">
        <span className="text-slate-500">Level</span>
        {([undefined, 'step', 'turn', 'run', 'flow'] as const).map((choice) => (
          <button key={choice ?? 'all'} type="button" onClick={() => setLevel(choice)} className={`rounded px-2 py-0.5 ${level === choice ? 'bg-sky-900/60 text-sky-200' : 'text-slate-400 hover:text-slate-200'}`}>
            {choice ? LEVEL_LABELS[choice] : 'All'}
          </button>
        ))}
        <span className="ml-4 text-slate-500">Model</span>
        {([undefined, 'yours', 'script', 'none'] as const).map((choice) => (
          <button key={choice ?? 'all'} type="button" onClick={() => setPlayer(choice)} className={`rounded px-2 py-0.5 ${player === choice ? 'bg-sky-900/60 text-sky-200' : 'text-slate-400 hover:text-slate-200'}`}>
            {choice ? MODEL_LABELS[choice] : 'All'}
          </button>
        ))}
      </section>

      {scenarios.isLoading && <p className="text-sm text-slate-500">Loading checks…</p>}
      {scenarios.isError && <p className="text-sm text-rose-400">Could not load the checks.</p>}
      {scenarios.data && inScope.length === 0 && <p className="text-sm text-slate-500">No check covers {scopeLabel(scope)} yet.</p>}

      <ul className="divide-y divide-[var(--bark-800)] rounded border border-[var(--bark-700)]">
        {shown.map((scenario) => {
          const history = historyOf(allRuns, scenario.id)
          const latest = history[0]
          const kind = checkKind(scenario)
          const open = opened?.scenarioId === scenario.id ? history.find((outcome) => outcome.runId === opened.runId) : undefined

          return (
            <li key={scenario.id}>
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <input
                  type="checkbox"
                  className="accent-sky-500"
                  checked={selection.isChosen(scenario.id)}
                  onChange={() => selection.toggle(scenario.id)}
                  aria-label={`Include ${scenario.name}`}
                />
                <span className={`w-4 text-center ${latest?.running ? 'animate-pulse text-sky-400' : latest?.result ? tone(latest.result.passed) : 'text-slate-600'}`}>
                  {latest?.running ? '◌' : latest?.result ? (latest.result.passed ? '✓' : '✕') : '·'}
                </span>
                {latest?.result?.attempts && (
                  <span className="font-mono text-[11px] text-slate-400" title={`${latest.result.passedAttempts ?? 0} of ${latest.result.attempts.length} attempts passed; it needs ${latest.result.passAt ?? latest.result.attempts.length}`}>
                    {latest.result.passedAttempts ?? 0}/{latest.result.attempts.length}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-200">{scenario.name}</span>
                  <span className="block truncate text-xs text-slate-500">{scenario.describe}</span>
                </span>
                <span className="rounded bg-[var(--bark-700)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-300">{LEVEL_LABELS[kind.level]}</span>
                <span className="rounded bg-[var(--bark-700)]/60 px-1.5 py-0.5 text-[10px] text-slate-400">{MODEL_LABELS[kind.model]}</span>
                <span className="flex items-center gap-0.5" aria-label={`History of ${scenario.name}`}>
                  {[...history].reverse().map((outcome) => (
                    <button
                      key={outcome.runId}
                      type="button"
                      disabled={!outcome.result}
                      onClick={() => setOpened(open?.runId === outcome.runId ? undefined : { scenarioId: scenario.id, runId: outcome.runId })}
                      title={`${when(outcome.at)} · ${outcome.modelLabel ?? 'account default'}${outcome.result?.attempts ? ` · ${outcome.result.passedAttempts ?? 0}/${outcome.result.attempts.length}` : ''}${outcome.regressed ? ' · regressed' : ''}`}
                      aria-label={`${outcome.running ? 'running' : outcome.result?.passed ? 'passed' : outcome.regressed ? 'regressed' : 'failed'} ${when(outcome.at)}`}
                      className={`w-2 rounded-sm ${outcome.regressed ? 'h-4 bg-rose-400' : 'h-3'} ${outcome.running ? 'animate-pulse bg-sky-500' : outcome.result?.passed ? 'bg-emerald-500/80' : outcome.regressed ? '' : 'bg-rose-500/80'} ${open?.runId === outcome.runId ? 'ring-1 ring-slate-200' : ''}`}
                    />
                  ))}
                </span>
                <span className="font-mono text-xs text-slate-600">{scenario.agent}{scenario.step ? ` · ${scenario.step.node}` : scenario.turn ? ` · ${scenario.expect.chooses?.tool ?? 'no tool'}` : ` · ${scenario.procedure.id}`}{(scenario.repeats ?? 1) > 1 ? ` · ×${scenario.repeats}` : ''}</span>
                <button type="button" disabled={Boolean(running)} onClick={() => launch([scenario.id])} className="text-xs text-slate-500 hover:text-sky-400 disabled:opacity-40">run</button>
                <button type="button" onClick={() => setEditing({ id: scenario.id })} className="text-xs text-slate-500 hover:text-sky-400">
                  {scenario.mine ? 'edit' : 'copy'}
                </button>
                {scenario.mine && (
                  <button type="button" onClick={() => remove.mutate(scenario.id)} className="text-xs text-slate-500 hover:text-rose-400">delete</button>
                )}
              </div>
              {open?.result && (
                <div className="px-3 pb-3">
                  <p className="mb-1 text-[11px] text-slate-500">{when(open.at)} · {open.modelLabel ?? 'account default'}</p>
                  <CheckResult result={open.result} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
