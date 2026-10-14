import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Check, Loader2, Square } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { answerRun, approveRunCall, cancelRun } from '../../api/engine'
import { pendingApproval, type EngineRunState, type PendingApproval } from '../../lib/engine-run-state'

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
      {approval && <ApprovalBox key={approval.callId} runId={run.runId} approval={approval} />}

      {waiting && !approval && !run.finished && run.currentNode && (
        <WaitingOnYou run={run} prompt={waiting.message} choices={waiting.choices} />
      )}
    </>
  )
}

type Decision = 'allow' | 'allow-for-run' | 'decline'

const DECIDED: Record<Decision, string> = {
  'allow': 'Allowed — it runs now.',
  'allow-for-run': 'Allowed for the rest of this run — it runs now.',
  'decline': 'Declined — the model is told it did not run.',
}

function ApprovalBox({ runId, approval }: { runId: string; approval: PendingApproval }) {
  const decide = useMutation({
    mutationFn: (decision: Decision) => approveRunCall(runId, {
      callId: approval.callId,
      allowed: decision !== 'decline',
      ...(decision === 'allow-for-run' ? { forRun: true } : {}),
    }),
  })
  const button = 'text-xs px-3 py-1 rounded border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center gap-1.5'
  const sending = (decision: Decision) => decide.isPending && decide.variables === decision ? <Loader2 size={11} className="animate-spin" /> : null

  return (
    <div className="border border-amber-500/30 bg-amber-500/10 rounded-md p-3 space-y-2" data-testid="approval">
      <p className="text-xs text-amber-300">{approval.message}</p>
      {decide.isSuccess ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-300" data-testid="approval-decided">
          <Check size={12} /> {DECIDED[decide.variables]}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate('allow')}
            className={`${button} bg-emerald-500/20 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/30`}
          >
            {sending('allow')}Allow
          </button>
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate('allow-for-run')}
            className={`${button} bg-emerald-500/10 text-emerald-300/80 border-emerald-500/20 hover:bg-emerald-500/20`}
          >
            {sending('allow-for-run')}Allow for this run
          </button>
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate('decline')}
            className={`${button} bg-red-500/20 text-red-300 border-red-500/30 hover:bg-red-500/30`}
          >
            {sending('decline')}Decline
          </button>
        </div>
      )}
      {decide.isError && <p className="text-xs text-rose-300">{errorMessage(decide.error)}</p>}
    </div>
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
