import { useState } from 'react'
import type { Check, ScenarioResult } from '../../api/evals'
import ScenarioTrace from './ScenarioTrace'

const tone = (passed: boolean) => (passed ? 'text-emerald-400' : 'text-rose-400')

function Checks({ checks }: { checks: readonly Check[] }) {
  return (
    <ul className="space-y-1">
      {checks.map((check) => (
        <li key={check.what} className="flex gap-2 text-xs">
          <span className={`w-3 shrink-0 ${tone(check.passed)}`}>{check.passed ? '✓' : '✕'}</span>
          <span className="text-slate-300">{check.what}</span>
          <span className="text-slate-500">{check.detail}</span>
        </li>
      ))}
    </ul>
  )
}

export default function CheckResult({ result: combined }: { result: ScenarioResult }) {
  const attempts = combined.attempts ?? []
  const [picked, setPicked] = useState(() => Math.max(0, attempts.findIndex((attempt) => attempt.runId === combined.runId)))
  const attempt = attempts[picked]
  const { conversationId: _conversation, error: _error, ...rest } = combined
  const result: ScenarioResult = attempt
    ? { ...rest, runId: attempt.runId, calls: attempt.calls, ...(attempt.conversationId ? { conversationId: attempt.conversationId } : {}), ...(attempt.error ? { error: attempt.error } : {}) }
    : combined

  return (
    <div className="min-w-0 space-y-3 overflow-hidden border-l-2 border-[var(--bark-700)] px-4 py-3">
      <Checks checks={combined.checks} />

      {attempt && (
        <div className="space-y-2 rounded border border-[var(--bark-700)] p-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Attempts">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">Attempts</span>
            {attempts.map((one, index) => (
              <button
                key={one.runId || index}
                type="button"
                onClick={() => setPicked(index)}
                aria-pressed={index === picked}
                aria-label={`Attempt ${index + 1}, ${one.passed ? 'passed' : 'failed'}`}
                className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${tone(one.passed)} ${index === picked ? 'bg-[var(--bark-700)] ring-1 ring-slate-400' : 'hover:bg-[var(--bark-800)]'}`}
              >
                #{index + 1} {one.passed ? '✓' : '✕'}
              </button>
            ))}
          </div>
          <Checks checks={attempt.checks} />
        </div>
      )}

      {result.error && <p className="font-mono text-xs text-rose-300">{result.error}</p>}

      {result.answer && !attempt && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">What it answered</p>
          <p className="whitespace-pre-wrap text-xs text-slate-400">{result.answer}</p>
        </div>
      )}

      {result.calls.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Tools it called</p>
          <ol className="space-y-0.5">
            {result.calls.map((call, index) => (
              <li key={`${call.name}-${index}`} className="flex min-w-0 gap-2 font-mono text-xs">
                <span className={`shrink-0 ${call.ok ? 'text-slate-400' : 'text-rose-400'}`}>{call.name}</span>
                <span className="min-w-0 truncate text-slate-600">{call.digest}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {result.tasks.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Tasks it left behind</p>
          <ul className="space-y-0.5">
            {result.tasks.map((task) => (
              <li key={task.id} className="text-xs text-slate-400">
                <span className="font-mono text-slate-300">{task.status}</span> {task.title}
                {task.evidence ? <span className="text-slate-600"> — {task.evidence}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ScenarioTrace result={result} />
    </div>
  )
}
