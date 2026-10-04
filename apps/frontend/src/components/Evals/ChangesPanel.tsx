import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { AgentChange, PromptChange } from '../../api/evals'
import { errorMessage } from '../../api/client'
import { lineDiff } from '../../lib/line-diff'
import { fieldClass, panelClass, primaryButton, quietButton, useChanges, useDecideChange } from './shared'

const WAITING = new Set(['proposed', 'comparing', 'ready'])

function standing(change: PromptChange): string {
  if (change.status === 'proposed') return 'waiting for the bench to compare it at the next idle moment'
  if (change.status === 'comparing') return 'the bench is comparing it now'
  const comparison = change.comparison
  if (!comparison || comparison.unchecked) return 'ready — the agent has no scenarios, so nothing was compared'
  return `ready — ${comparison.better.length} got better, ${comparison.worse.length} got worse, across ${comparison.scenarios.length} scenario${comparison.scenarios.length === 1 ? '' : 's'}`
}

function PromptChangeCard({ change }: { change: PromptChange }) {
  const { accept, dismiss } = useDecideChange()
  const [editing, setEditing] = useState<string>()
  const ready = change.status === 'ready'

  return (
    <li className="rounded border border-slate-800 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold text-slate-200">Prompt change for {change.agent}</span>
        <span className="text-xs text-slate-500">{standing(change)}</span>
      </div>
      <p className="mt-1 text-xs text-slate-400">Why: {change.why}</p>
      <pre aria-label={`What changes in ${change.agent}'s prompt`} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 text-[11px]">
        {lineDiff(change.currentPrompt, editing ?? change.prompt).filter((entry) => entry.kind !== 'same').map((entry, index) => (
          <span key={index} className={`block ${entry.kind === 'added' ? 'text-emerald-300' : 'text-rose-300 line-through'}`}>{entry.kind === 'added' ? '+ ' : '− '}{entry.line}</span>
        ))}
      </pre>
      {change.comparison && change.comparison.scenarios.length > 0 && (
        <ul className="mt-2 text-xs">
          {change.comparison.scenarios.map((entry) => (
            <li key={entry.scenarioId} className={entry.before === true && !entry.after ? 'text-rose-300' : entry.before === false && entry.after ? 'text-emerald-300' : 'text-slate-400'}>
              {entry.scenarioId}: {entry.before === undefined ? 'new' : entry.before ? 'passed' : 'failed'} → {entry.after ? 'passes' : 'fails'}
            </li>
          ))}
        </ul>
      )}
      {editing !== undefined && (
        <textarea aria-label={`The new prompt for ${change.agent}`} value={editing} onChange={(event) => setEditing(event.target.value)} rows={8} className={`mt-2 w-full text-xs ${fieldClass}`} />
      )}
      {(accept.error ?? dismiss.error) && (
        <p className="mt-1 text-xs text-rose-300">
          {errorMessage(accept.error ?? dismiss.error)}
          {((accept.error as { response?: { data?: { problems?: string[] } } } | null)?.response?.data?.problems ?? []).map((problem) => <span key={problem} className="block">{problem}</span>)}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={!ready || accept.isPending} onClick={() => accept.mutate({ id: change.id, ...(editing !== undefined ? { prompt: editing } : {}) })} className={primaryButton}>
          {editing !== undefined ? 'Accept my edit' : 'Accept'}
        </button>
        {editing === undefined && <button type="button" onClick={() => setEditing(change.prompt)} className={quietButton}>Edit, then accept</button>}
        <button type="button" disabled={dismiss.isPending} onClick={() => dismiss.mutate(change.id)} className={quietButton}>Dismiss</button>
      </div>
    </li>
  )
}

export default function ChangesPanel() {
  const navigate = useNavigate()
  const changes = useChanges()
  const { handOver, dismiss } = useDecideChange((conversationId) => {
    navigate({ to: '/chat/$conversationId', params: { conversationId } }).catch(() => undefined)
  })
  const waiting = (changes.data ?? []).filter((change: AgentChange) => WAITING.has(change.status))
  if (waiting.length === 0) return null

  return (
    <section className={`flex flex-col gap-3 ${panelClass}`}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Proposed changes ({waiting.length})</h3>
      <p className="text-xs text-slate-500">Prompt changes are compared on the bench and always wait for you. Procedure changes are asked for in plain words; hand one to the agent builder to make it.</p>
      {handOver.error && <p className="text-xs text-rose-300">{errorMessage(handOver.error)}</p>}
      <ul className="flex flex-col gap-2">
        {waiting.map((change) => (change.kind === 'prompt'
          ? <PromptChangeCard key={change.id} change={change} />
          : (
            <li key={change.id} className="rounded border border-slate-800 p-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold text-slate-200">Change to the procedure {change.procedure}</span>
                <span className="text-xs text-slate-500">for {change.agent}</span>
              </div>
              <p className="mt-1 text-xs text-slate-300">{change.request}</p>
              <p className="mt-1 text-xs text-slate-400">Why: {change.why}</p>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={handOver.isPending} onClick={() => handOver.mutate(change.id)} className={primaryButton}>Hand to the agent builder</button>
                <button type="button" disabled={dismiss.isPending} onClick={() => dismiss.mutate(change.id)} className={quietButton}>Dismiss</button>
              </div>
            </li>
          )))}
      </ul>
    </section>
  )
}
