import { useState } from 'react'
import { errorMessage } from '../../api/client'
import type { Scenario } from '../../api/evals'
import { draftOf, emptyDraft, scenarioFromDraft, type ScenarioDraft } from '../../lib/scenario-draft'
import { fieldClass, primaryButton, quietButton, useSaveScenario } from './shared'

interface ScenarioEditorProps {
  scenario: Scenario | undefined
  agents: string[]
  procedures: string[]
  onClose: () => void
  onSaved: (scenario: Scenario) => void
}

export default function ScenarioEditor({ scenario, agents, procedures, onClose, onSaved }: ScenarioEditorProps) {
  const [draft, setDraft] = useState<ScenarioDraft>(() => (scenario ? draftOf(scenario) : emptyDraft(agents[0] ?? '')))
  const [problems, setProblems] = useState<string[]>([])
  const save = useSaveScenario(onSaved)

  const set = <K extends keyof ScenarioDraft>(key: K, value: ScenarioDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const submit = () => {
    const outcome = scenarioFromDraft(draft)
    if ('problems' in outcome) return setProblems(outcome.problems)
    setProblems([])
    save.mutate(outcome.scenario, {
      onError: (err) => setProblems([
        errorMessage(err),
        ...((err as { response?: { data?: { problems?: string[] } } }).response?.data?.problems ?? []),
      ]),
    })
  }

  const field = (label: string, key: keyof ScenarioDraft, placeholder = '') => (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      {label}
      <input
        value={String(draft[key])}
        onChange={(event) => set(key, event.target.value as ScenarioDraft[typeof key])}
        placeholder={placeholder}
        className={fieldClass}
      />
    </label>
  )

  const area = (label: string, key: keyof ScenarioDraft, placeholder = '', rows = 4) => (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      {label}
      <textarea
        value={String(draft[key])}
        onChange={(event) => set(key, event.target.value as ScenarioDraft[typeof key])}
        rows={rows}
        placeholder={placeholder}
        className={`${fieldClass} font-mono text-xs`}
      />
    </label>
  )

  return (
    <section className="space-y-4 rounded border border-sky-900/60 bg-slate-950 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-100">
          {scenario?.mine ? `Editing ${scenario.name}` : scenario ? `Your own copy of ${scenario.name}` : 'A new scenario'}
        </h2>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-200">Close</button>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {field('Id', 'id', 'executor-does-one-task')}
        {field('Name', 'name', 'The executor finishes a task in its sandbox')}

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Persona
          <select value={draft.agent} onChange={(event) => set('agent', event.target.value)} className={fieldClass}>
            <option value="">choose a persona</option>
            {agents.map((slug) => <option key={slug} value={slug}>{slug}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Procedure
          <select value={draft.procedure} onChange={(event) => set('procedure', event.target.value)} className={fieldClass}>
            <option value="">choose a procedure</option>
            {procedures.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>

        {field('Pinned version, blank for whatever is current', 'version', 'auto')}

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Approvals
          <select
            value={draft.approvals}
            onChange={(event) => set('approvals', event.target.value as 'allow' | 'refuse')}
            className={fieldClass}
          >
            <option value="allow">allow every tool that asks</option>
            <option value="refuse">refuse every tool that asks</option>
          </select>
        </label>
      </div>

      {area('What it checks', 'describe', 'It should claim the task, write the file, and record the task done.', 2)}
      {area('What the run is asked to do', 'message', 'Do the task you have been given.', 3)}

      <div className="grid gap-3 sm:grid-cols-2">
        {area('Extra inputs, as JSON', 'inputs', '{\n  "item": { "id": "write-greeting" }\n}')}
        {area('Scripted answers by node id, as JSON', 'answers', '{\n  "review": "Accepted on the board."\n}')}
      </div>

      {area('The world it wakes up in, as JSON: tasks, files, procedures, memories', 'world', '{\n  "files": { "notes/todo.md": "check the indexes\\n" }\n}', 6)}

      <label className="flex items-center gap-2 text-xs text-slate-400">
        <input
          type="checkbox"
          checked={draft.acceptProposedWork}
          onChange={(event) => set('acceptProposedWork', event.target.checked)}
          className="accent-sky-500"
        />
        A person accepts proposed work when the run waits for one
      </label>

      <fieldset className="space-y-3 rounded border border-slate-800 p-3">
        <legend className="px-1 text-xs uppercase tracking-wide text-slate-500">What has to be true afterwards</legend>

        <div className="grid gap-3 sm:grid-cols-2">
          {field('Outcome', 'outcome', 'ok')}
          {field('Tools it has to call, comma separated', 'toolsCalled', 'propose_work')}
          {field('Tools it must not call', 'toolsNotCalled', 'save_procedure')}
          {field('Tools in this order', 'toolsInOrder', 'start_task, mark_done')}
          {field('Within rounds', 'rounds', '8')}
          {field('Within tool calls', 'toolCalls', 'auto')}
          {field('Within total tokens', 'totalTokens', 'auto')}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {field('A procedure it has to leave in the store', 'savedProcedure', 'tidy')}
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            And it has to be
            <select
              value={draft.savedStored}
              onChange={(event) => set('savedStored', event.target.value as 'yes' | 'no')}
              className={fieldClass}
            >
              <option value="yes">stored, and what is stored checks clean</option>
              <option value="no">not stored at all</option>
            </select>
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {field('Provoke this tool to fail', 'provokesTool', 'read_procedure')}
          {field('When', 'provokesWhen', 'no procedure has that id')}
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            And then it has to be
            <select
              value={draft.provokesThen}
              onChange={(event) => set('provokesThen', event.target.value as 'retried' | 'reported')}
              className={fieldClass}
            >
              <option value="reported">reported to the person</option>
              <option value="retried">retried</option>
            </select>
          </label>
        </div>
      </fieldset>

      {problems.length > 0 && (
        <ul className="space-y-1 rounded border border-rose-900 bg-rose-950/30 p-3">
          {problems.map((problem) => <li key={problem} className="text-xs text-rose-300">{problem}</li>)}
        </ul>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={save.isPending} className={primaryButton}>
          {save.isPending ? 'Saving…' : 'Save scenario'}
        </button>
        <button type="button" onClick={onClose} className={quietButton}>Cancel</button>
      </div>
    </section>
  )
}
