import { useState } from 'react'
import { Square } from 'lucide-react'
import { answerRun, approveRunCall, cancelRun } from '../../api/engine'
import { pendingApproval, type EngineRunState } from '../../lib/engine-run-state'

export function StopRun({ run }: { run: Pick<EngineRunState, 'runId' | 'finished'> }) {
  if (run.finished) return null
  return (
    <button
      type="button"
      onClick={() => void cancelRun(run.runId)}
      className="ml-auto text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1 cursor-pointer"
    >
      <Square size={10} /> Stop
    </button>
  )
}

export default function RunControls({ run }: { run: EngineRunState }) {
  const approval = pendingApproval(run)
  const waiting = run.notices.filter((notice) => notice.level === 'info').at(-1)

  return (
    <>
      {approval && !run.finished && (
        <div className="border border-amber-500/30 bg-amber-500/10 rounded-md p-3 space-y-2">
          <p className="text-xs text-amber-300">{approval}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void approveRunCall(run.runId, { callId: lastCallId(run), allowed: true })}
              className="text-xs px-3 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors"
            >
              Allow
            </button>
            <button
              type="button"
              onClick={() => void approveRunCall(run.runId, { callId: lastCallId(run), allowed: true, forRun: true })}
              className="text-xs px-3 py-1 rounded bg-emerald-500/10 text-emerald-300/80 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
            >
              Allow for this run
            </button>
            <button
              type="button"
              onClick={() => void approveRunCall(run.runId, { callId: lastCallId(run), allowed: false })}
              className="text-xs px-3 py-1 rounded bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 transition-colors"
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {waiting && !approval && !run.finished && run.currentNode && (
        <WaitingOnYou run={run} prompt={waiting.message} choices={waiting.choices} />
      )}
    </>
  )
}

function WaitingOnYou({ run, prompt, choices }: { run: EngineRunState; prompt: string; choices?: string[] | undefined }) {
  const [answer, setAnswer] = useState('')

  if (choices?.length) {
    return (
      <div className="border border-[var(--bark-800)] rounded-md p-3 space-y-2" data-testid="waiting-on-you">
        <p className="whitespace-pre-wrap text-xs text-slate-300">{prompt}</p>
        <div className="flex flex-wrap gap-2">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => { if (run.currentNode) void answerRun(run.runId, run.currentNode, choice) }}
              className="text-xs px-3 py-1 rounded bg-[var(--leaf-stem)]/20 text-[var(--leaf)] border border-[var(--leaf-stem)]/30 hover:bg-[var(--leaf-stem)]/30 transition-colors cursor-pointer"
            >
              {choice}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="border border-[var(--bark-800)] rounded-md p-3 space-y-2" data-testid="waiting-on-you">
      <p className="text-xs text-slate-300">{prompt}</p>
      <div className="flex gap-2">
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Your answer"
          className="flex-1 bg-[var(--bark-950)] border border-[var(--bark-800)] rounded px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf-stem)]"
        />
        <button
          type="button"
          onClick={() => {
            if (!answer.trim() || !run.currentNode) return
            void answerRun(run.runId, run.currentNode, answer.trim())
            setAnswer('')
          }}
          className="text-xs px-3 py-1 rounded bg-[var(--leaf-stem)]/20 text-[var(--leaf)] border border-[var(--leaf-stem)]/30 hover:bg-[var(--leaf-stem)]/30 transition-colors cursor-pointer"
        >
          Answer
        </button>
      </div>
    </div>
  )
}

const lastCallId = (run: EngineRunState): string =>
  run.toolCalls.at(-1)?.callId ?? 'unknown'
