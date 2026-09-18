import { useState } from 'react'
import { errorMessage } from '../../api/client'
import type { EvalCase, EvalCategory } from '../../api/evals'
import { argLine, parseArgLines } from '../../lib/eval-case-args'
import { fieldClass, primaryButton, quietButton, useSaveCase } from './shared'

const CATEGORIES: { value: EvalCategory; label: string }[] = [
  { value: 'simple', label: 'one call' },
  { value: 'multiple', label: 'picks from several' },
  { value: 'irrelevance', label: 'should call nothing' },
]

interface CaseEditorProps {
  entry: EvalCase | undefined
  agents: string[]
  onClose: () => void
  onSaved: (entry: EvalCase) => void
}

export default function CaseEditor({ entry, agents, onClose, onSaved }: CaseEditorProps) {
  const [name, setName] = useState(entry?.name ?? '')
  const [category, setCategory] = useState<EvalCategory>(entry?.category ?? 'simple')
  const [agent, setAgent] = useState(entry?.agent ?? agents[0] ?? '')
  const [say, setSay] = useState(entry?.say ?? '')
  const [tool, setTool] = useState(entry?.expect.tool ?? '')
  const [args, setArgs] = useState((entry?.expect.args ?? []).map(argLine).join('\n'))
  const [repeats, setRepeats] = useState(entry?.repeats ? String(entry.repeats) : '')
  const [problems, setProblems] = useState<string[]>([])

  const save = useSaveCase(onSaved)

  const submit = () => {
    const { checks, problems: bad } = parseArgLines(args)
    if (bad.length > 0) return setProblems(bad)

    setProblems([])
    save.mutate({
      name: name.trim(),
      category,
      agent,
      say,
      expect: {
        tool: category === 'irrelevance' || !tool.trim() ? null : tool.trim(),
        ...(checks.length > 0 ? { args: checks } : {}),
      },
      ...(repeats.trim() ? { repeats: Number(repeats) } : {}),
    }, {
      onError: (err) => setProblems([errorMessage(err), ...((err as { response?: { data?: { problems?: string[] } } }).response?.data?.problems ?? [])]),
    })
  }

  return (
    <section className="space-y-3 rounded border border-sky-900/60 bg-slate-950 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-100">
          {entry?.mine ? `Editing ${entry.name}` : entry ? `Your own copy of ${entry.name}` : 'A new case'}
        </h2>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-200">Close</button>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Name, as group/case
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="read/by-name" className={fieldClass} />
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Persona
          <select value={agent} onChange={(event) => setAgent(event.target.value)} className={fieldClass}>
            {agents.map((slug) => <option key={slug} value={slug}>{slug}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          What kind of case
          <select value={category} onChange={(event) => setCategory(event.target.value as EvalCategory)} className={fieldClass}>
            {CATEGORIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Repeats, blank for the run's own
          <input value={repeats} onChange={(event) => setRepeats(event.target.value)} placeholder="auto" className={fieldClass} />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        What it is asked
        <textarea value={say} onChange={(event) => setSay(event.target.value)} rows={4} className={`${fieldClass} font-mono text-xs`} />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          The tool it should call
          <input
            value={category === 'irrelevance' ? '' : tool}
            disabled={category === 'irrelevance'}
            onChange={(event) => setTool(event.target.value)}
            placeholder={category === 'irrelevance' ? 'nothing at all' : 'read_procedure'}
            className={`${fieldClass} font-mono disabled:opacity-40`}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          What the arguments must say, one per line
          <textarea
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            rows={3}
            placeholder={'procedure is research\nsource contains tidy'}
            className={`${fieldClass} font-mono text-xs`}
          />
        </label>
      </div>

      {problems.length > 0 && (
        <ul className="space-y-1 rounded border border-rose-900 bg-rose-950/30 p-3">
          {problems.map((problem) => <li key={problem} className="text-xs text-rose-300">{problem}</li>)}
        </ul>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={save.isPending} className={primaryButton}>
          {save.isPending ? 'Saving…' : 'Save case'}
        </button>
        <button type="button" onClick={onClose} className={quietButton}>Cancel</button>
      </div>
    </section>
  )
}
