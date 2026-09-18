import { useState } from 'react'
import { X } from 'lucide-react'
import type { EvalCase, Level1Run } from '../../api/evals'
import { attemptsOf } from '../../lib/level1-run'
import { CATEGORY_LABEL, quietButton, usePrompt } from './shared'

interface CaseDetailProps {
  entry: EvalCase
  run: Level1Run | undefined
  onEdit: () => void
  onDelete: () => void
  onRun: () => void
  onClose: () => void
}

export default function CaseDetail({ entry, run, onEdit, onDelete, onRun, onClose }: CaseDetailProps) {
  const [showing, setShowing] = useState<string>()
  const prompt = usePrompt(showing)
  const attempts = attemptsOf(run, entry.name)

  return (
    <section className="rounded border border-slate-800 bg-slate-950">
      <header className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate font-mono text-sm text-slate-100">{entry.name}</h2>
        <span className="text-xs text-slate-500">{CATEGORY_LABEL[entry.category] ?? entry.category}</span>
        <span className="text-xs text-slate-500">{entry.mine ? 'yours' : 'built in'}</span>
        <button type="button" onClick={onRun} className={quietButton}>Run this</button>
        <button type="button" onClick={onEdit} className={quietButton}>{entry.mine ? 'Edit' : 'Make my own'}</button>
        {entry.mine && (
          <button type="button" onClick={onDelete} className="rounded border border-rose-900 px-3 py-1.5 text-sm text-rose-300">
            Delete
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close case" className="text-slate-500 hover:text-slate-200">
          <X size={16} />
        </button>
      </header>

      <div className="space-y-3 px-4 py-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">What it is asked</p>
          <p className="whitespace-pre-wrap text-sm text-slate-300">{entry.say}</p>
        </div>

        <div className="flex flex-wrap gap-4 text-xs text-slate-400">
          <span>persona <span className="font-mono text-slate-200">{entry.agent}</span></span>
          <span>expects <span className="font-mono text-slate-200">{entry.expect.tool ?? 'no tool at all'}</span></span>
          {(entry.expect.args ?? []).map((check) => (
            <span key={JSON.stringify(check)} className="font-mono text-slate-500">
              {check.arg} {'is' in check ? `= ${check.is}` : 'contains' in check ? `contains ${check.contains}` : 'matches' in check ? `matches ${check.matches}` : 'is not empty'}
            </span>
          ))}
          {entry.provokes && (
            <span>provokes <span className="font-mono text-slate-200">{entry.provokes.tool}</span> when {entry.provokes.when}</span>
          )}
        </div>

        {attempts.length === 0
          ? <p className="text-sm text-slate-500">This case has not run in the run you are looking at.</p>
          : (
            <ol className="space-y-2">
              {attempts.map((attempt) => (
                <li key={attempt.attempt} className="rounded border border-slate-800 bg-slate-900/40 p-3">
                  <div className="flex flex-wrap items-baseline gap-3 text-xs">
                    <span className={attempt.passed ? 'text-emerald-400' : 'text-rose-400'}>
                      attempt {attempt.attempt + 1} {attempt.passed ? 'passed' : 'failed'}
                    </span>
                    <span className="text-slate-500">{attempt.totalTokens} tokens · {attempt.latencyMs}ms</span>
                    {attempt.systemHash && (
                      <button
                        type="button"
                        onClick={() => setShowing(showing === attempt.systemHash ? undefined : attempt.systemHash)}
                        className="font-mono text-slate-500 hover:text-sky-400"
                      >
                        prompt {attempt.systemHash.slice(0, 8)}
                      </button>
                    )}
                    <span className="font-mono text-slate-600">offered {attempt.toolsOffered.length} tools</span>
                  </div>

                  {attempt.complaint && <p className="mt-1 font-mono text-xs text-rose-300">{attempt.complaint}</p>}

                  {attempt.toolCalls.map((call, index) => (
                    <p key={`${call.name}-${index}`} className="mt-1 break-all font-mono text-xs text-slate-300">
                      {call.name}({call.arguments})
                    </p>
                  ))}

                  {attempt.content && <p className="mt-1 whitespace-pre-wrap text-xs text-slate-400">{attempt.content}</p>}

                  {showing && showing === attempt.systemHash && (
                    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-3 text-xs text-slate-400">
                      {prompt.isPending ? 'Loading the prompt…' : prompt.data ?? 'That prompt was not kept.'}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          )}
      </div>
    </section>
  )
}
